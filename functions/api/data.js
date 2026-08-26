const SEED_DATA = {
  settings: {
    businessName: "Honeydees",
    halalBadge: "100% Strictly Halal",
    heroHeading: "Cape Town's Friday Night Treat",
    heroSubtitle: "Flame-grilled Masala steak sandwiches, saucy wraps & handcrafted mocktails.",
    scheduleNotice: "Collection: 14 Viola St, Lentegeur (From 6:00 PM)",
    collectionAddress: "14 Viola Street, Lentegeur, Mitchells Plain",
    collectionTimes: "Fridays 6:00 PM–9:30 PM",
    deliveryFee: 30,
    bankName: "Standard Bank",
    accountHolder: "Honeydees Food Enterprise",
    accountNumber: "10192837465",
    branchCode: "051001"
  },
  categories: [
    { id: "cat_mains", name: "Main Meals" },
    { id: "cat_wraps", name: "Wraps & Grills" },
    { id: "cat_mocktails", name: "Artisanal Mocktails" },
    { id: "cat_desserts", name: "Desserts & Treats" }
  ],
  menu: [
    { id: "item_1", name: "Masala Steak Sandwich", description: "Masala steak cutlets, slap chips & fresh salad.", price: 65, categoryId: "cat_mains", imageUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=600&auto=format&fit=crop&q=80", available: true, featured: true }
  ]
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }

  const authHeader = request.headers.get("Authorization") || "";
  const adminSecret = env.ADMIN_PASSWORD || "Honeydees2026!";
  const isAdmin = authHeader === adminSecret;

  try {
    if (request.method === "GET") {
      const trackToken = url.searchParams.get("track");
      if (trackToken) {
        const id = await env.HONEYDEES_DB.get(`track:${trackToken}`);
        if (!id) return jsonResponse({ error: "Not found" }, 404);
        return jsonResponse(await env.HONEYDEES_DB.get(`order:${id}`, "json"));
      }

      let settings = await env.HONEYDEES_DB.get("settings", "json") || SEED_DATA.settings;
      let categories = await env.HONEYDEES_DB.get("categories", "json") || SEED_DATA.categories;
      let menu = await env.HONEYDEES_DB.get("menu", "json") || SEED_DATA.menu;
      let orders = [];

      if (isAdmin) {
        const index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        for (const id of index.slice(0, 150)) {
          const od = await env.HONEYDEES_DB.get(`order:${id}`, "json");
          if (od) orders.push(od);
        }
      }
      return jsonResponse({ authenticated: isAdmin, public: { settings, categories, menu }, orders: isAdmin ? orders : undefined });
    }

    if (request.method === "POST") {
      const body = await request.json();

      if (body.action === "createOrder") {
        const { customer, orderType, deliveryAddress, items, popBase64 } = body.data;
        if (!popBase64) return jsonResponse({ error: "POP strictly required." }, 400);

        const menu = await env.HONEYDEES_DB.get("menu", "json") || SEED_DATA.menu;
        const settings = await env.HONEYDEES_DB.get("settings", "json") || SEED_DATA.settings;
        const menuMap = new Map(menu.map(i => [i.id, i]));
        let subtotal = 0, verifiedItems = [];

        for (const i of items) {
          const s = menuMap.get(i.id);
          if (!s || !s.available) return jsonResponse({ error: `Unavailable: ${i.name}` }, 400);
          const qty = Math.max(1, parseInt(i.quantity, 10) || 1);
          const lineTotal = s.price * qty;
          subtotal += lineTotal;
          verifiedItems.push({ id: s.id, name: s.name, price: s.price, quantity: qty, lineTotal });
        }

        const deliveryFee = orderType === "DELIVERY" ? (Number(settings.deliveryFee) || 30) : 0;
        const total = subtotal + deliveryFee;
        const orderNumber = "HD-" + Math.floor(100000 + Math.random() * 900000);
        const trackingToken = crypto.randomUUID();

        const newOrder = {
          id: "ord_" + Date.now(),
          orderNumber, trackingToken, customer, orderType, deliveryAddress: deliveryAddress || "",
          items: verifiedItems, subtotal, deliveryFee, total,
          status: "PAYMENT PROOF RECEIVED", popBase64,
          createdAt: new Date().toLocaleDateString("en-GB") + " " + new Date().toLocaleTimeString("en-GB")
        };

        await env.HONEYDEES_DB.put(`order:${newOrder.id}`, JSON.stringify(newOrder));
        await env.HONEYDEES_DB.put(`track:${trackingToken}`, newOrder.id);
        
        let index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        index.unshift(newOrder.id);
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify(index.slice(0, 1000)));

        return jsonResponse({ success: true, trackingToken, orderNumber, total });
      }

      if (body.action === "uploadLatePOP") {
        const { trackingToken, popBase64 } = body.data;
        if (!popBase64) return jsonResponse({ error: "No file" }, 400);
        const orderId = await env.HONEYDEES_DB.get(`track:${trackingToken}`);
        if (!orderId) return jsonResponse({ error: "Not found" }, 404);
        
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        order.popBase64 = popBase64;
        order.status = "PAYMENT PROOF RECEIVED";
        await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (!isAdmin) return jsonResponse({ error: "Unauthorized" }, 401);

      if (body.action === "updateOrderStatus") {
        const { orderId, status } = body.data;
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        if (!order) return jsonResponse({ error: "Not found" }, 404);
        order.status = status;
        await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (body.action === "clearCompletedOrders") {
        let index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        let newIndex = [];
        for (const i of index) {
          const order = await env.HONEYDEES_DB.get(`order:${i}`, "json");
          if (order && order.status === "COMPLETED") {
            await env.HONEYDEES_DB.delete(`order:${i}`);
            await env.HONEYDEES_DB.delete(`track:${order.trackingToken}`);
          } else {
            newIndex.push(i);
          }
        }
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify(newIndex));
        return jsonResponse({ success: true });
      }

      if (body.action === "adminSaveAll") {
        const { settings, menu, categories } = body.data;
        if (settings) await env.HONEYDEES_DB.put("settings", JSON.stringify(settings));
        if (menu) await env.HONEYDEES_DB.put("menu", JSON.stringify(menu));
        if (categories) await env.HONEYDEES_DB.put("categories", JSON.stringify(categories));
        return jsonResponse({ success: true });
      }
    }
    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
                                         }
