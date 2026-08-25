/**
 * HONEYDEES ORDERING PWA - Cloudflare Worker
 * Bindings: HONEYDEES_DB (KV), HONEYDEES_UPLOADS (R2), ADMIN_PASSWORD (Secret)
 */

const SEED_DATA = {
  settings: {
    businessName: "Honeydees Halal Kitchen",
    collectionAddress: "14 Viola Street, Lentegeur, Mitchells Plain",
    collectionTimes: "Fridays from 6:00 PM – 9:30 PM",
    deliveryFee: 30.00,
    bankName: "Standard Bank",
    accountHolder: "Honeydees Food",
    accountNumber: "10192837465",
    branchCode: "051001",
    contacts: [
      { name: "Haniefa Davids", phone: "0839897938" },
      { name: "Riedah Davids", phone: "0672216024" }
    ]
  },
  categories: [
    { id: "cat_mains", name: "Main Meals", order: 1 },
    { id: "cat_wraps", name: "Wraps", order: 2 },
    { id: "cat_mocktails", name: "Mocktails", order: 3 },
    { id: "cat_desserts", name: "Desserts", order: 4 }
  ],
  menu: [
    { id: "item_1", name: "Masala Steak Sandwich", description: "Masala steak, slap chips & fresh salads.", price: 65, categoryId: "cat_mains", imageUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=600&auto=format&fit=crop&q=80", available: true, featured: true },
    { id: "item_2", name: "Full House Steak Sandwich", description: "Masala steak, egg, cheese, chips & salads.", price: 85, categoryId: "cat_mains", imageUrl: "https://images.unsplash.com/photo-1550547660-d9450f859349?w=600&auto=format&fit=crop&q=80", available: true, featured: true },
    { id: "item_3", name: "Saucy Chicken Wrap", description: "Saucy chicken wrap with crispy slap chips & fresh salads.", price: 65, categoryId: "cat_wraps", imageUrl: "https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=600&auto=format&fit=crop&q=80", available: true, featured: false },
    { id: "item_4", name: "Watermelon & Passion Fruit Mocktail", description: "Fresh crushed watermelon, passion fruit pulp & sparkling soda.", price: 20, categoryId: "cat_mocktails", imageUrl: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?w=600&auto=format&fit=crop&q=80", available: true, featured: true },
    { id: "item_5", name: "Classic Rose Falooda", description: "Rich cardamom rose milk, falooda noodles, tukmaria & ice cream.", price: 30, categoryId: "cat_desserts", imageUrl: "https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=600&auto=format&fit=crop&q=80", available: true, featured: false }
  ]
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return handleCORS();

    try {
      // 1. PUBLIC API
      if (path === "/api/bootstrap" && request.method === "GET") {
        let settings = await env.HONEYDEES_DB.get("settings", "json") || SEED_DATA.settings;
        let categories = await env.HONEYDEES_DB.get("categories", "json") || SEED_DATA.categories;
        let menu = await env.HONEYDEES_DB.get("menu", "json") || SEED_DATA.menu;
        return jsonResponse({ settings, categories, menu });
      }

      if (path === "/api/orders" && request.method === "POST") {
        const body = await request.json();
        const menu = await env.HONEYDEES_DB.get("menu", "json") || SEED_DATA.menu;
        const settings = await env.HONEYDEES_DB.get("settings", "json") || SEED_DATA.settings;
        const menuMap = new Map(menu.map(i => [i.id, i]));

        let subtotal = 0;
        const verifiedItems = [];
        for (const itm of body.items) {
          const srv = menuMap.get(itm.id);
          if (!srv || !srv.available) return jsonResponse({ error: `Item unavailable: ${itm.name}` }, 400);
          const qty = Math.max(1, parseInt(itm.quantity, 10) || 1);
          const lineTotal = srv.price * qty;
          subtotal += lineTotal;
          verifiedItems.push({ id: srv.id, name: srv.name, price: srv.price, quantity: qty, lineTotal });
        }

        const deliveryFee = body.orderType === "DELIVERY" ? (Number(settings.deliveryFee) || 30) : 0;
        const total = subtotal + deliveryFee;
        const orderNumber = "HD-" + Math.floor(100000 + Math.random() * 900000);
        const trackingToken = crypto.randomUUID();

        const newOrder = {
          id: "ord_" + Date.now(),
          orderNumber,
          trackingToken,
          customer: body.customer,
          orderType: body.orderType,
          deliveryAddress: body.deliveryAddress || "",
          notes: body.notes || "",
          items: verifiedItems,
          subtotal,
          deliveryFee,
          total,
          status: body.popFileUrl ? "PAYMENT_REVIEW" : "PAYMENT_PENDING",
          popFileUrl: body.popFileUrl || null,
          createdAt: new Date().toISOString()
        };

        await env.HONEYDEES_DB.put(`order:${newOrder.id}`, JSON.stringify(newOrder));
        await env.HONEYDEES_DB.put(`track:${trackingToken}`, newOrder.id);

        let index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        index.unshift(newOrder.id);
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify(index.slice(0, 1000)));

        return jsonResponse({ success: true, trackingToken, orderNumber, total });
      }

      if (path.startsWith("/api/orders/track/") && request.method === "GET") {
        const token = path.replace("/api/orders/track/", "");
        const orderId = await env.HONEYDEES_DB.get(`track:${token}`);
        if (!orderId) return jsonResponse({ error: "Order not found" }, 404);
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        return jsonResponse(order);
      }

      if (path === "/api/upload" && request.method === "POST") {
        const formData = await request.formData();
        const file = formData.get("file");
        if (!file) return jsonResponse({ error: "No file attached" }, 400);

        const key = `uploads/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "")}`;
        await env.HONEYDEES_UPLOADS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
        return jsonResponse({ url: `/api/media/${encodeURIComponent(key)}` });
      }

      if (path.startsWith("/api/media/") && request.method === "GET") {
        const key = decodeURIComponent(path.replace("/api/media/", ""));
        const obj = await env.HONEYDEES_UPLOADS.get(key);
        if (!obj) return new Response("Not Found", { status: 404 });
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return new Response(obj.body, { headers });
      }

      // 2. ADMIN API (AUTH PROTECTED)
      const auth = request.headers.get("Authorization");
      const adminPass = env.ADMIN_PASSWORD || "Honeydees2026!";

      if (path === "/api/admin/auth" && request.method === "POST") {
        const { password } = await request.json();
        if (password === adminPass) return jsonResponse({ success: true, token: adminPass });
        return jsonResponse({ error: "Invalid password" }, 401);
      }

      if (path.startsWith("/api/admin/")) {
        if (auth !== adminPass) return jsonResponse({ error: "Unauthorized" }, 401);

        if (path === "/api/admin/orders" && request.method === "GET") {
          const index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
          const orders = [];
          for (const id of index.slice(0, 150)) {
            const o = await env.HONEYDEES_DB.get(`order:${id}`, "json");
            if (o) orders.push(o);
          }
          return jsonResponse({ orders });
        }

        if (path.startsWith("/api/admin/orders/") && path.endsWith("/status") && request.method === "PATCH") {
          const orderId = path.split("/")[4];
          const { status } = await request.json();
          const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
          if (!order) return jsonResponse({ error: "Not found" }, 404);
          order.status = status;
          await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
          return jsonResponse({ success: true, order });
        }

        if (path === "/api/admin/save" && request.method === "POST") {
          const { type, data } = await request.json();
          await env.HONEYDEES_DB.put(type, JSON.stringify(data));
          return jsonResponse({ success: true });
        }
      }

      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization" }
  });
}
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" }
  });
          }
