/**
 * HONEYDEES BACKEND API (Cloudflare Pages Function)
 * Handles KV Database Storage, Server-Side Order Calculations & Password Auth
 */

const SEED_DATA = {
  settings: {
    businessName: "Honeydees Halal Kitchen",
    collectionAddress: "14 Viola Street, Lentegeur, Mitchells Plain",
    collectionTimes: "Fridays from 6:00 PM – 9:30 PM",
    deliveryFee: 30.00,
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
    { id: "item_1", name: "Masala Steak Sandwich", description: "Masala steak cutlets, crispy slap chips & fresh salad.", price: 65, categoryId: "cat_mains", imageUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=600&auto=format&fit=crop&q=80", available: true, featured: true },
    { id: "item_2", name: "Full House Steak Sandwich", description: "Masala steak, fried egg, cheese, chips & salad.", price: 85, categoryId: "cat_mains", imageUrl: "https://images.unsplash.com/photo-1550547660-d9450f859349?w=600&auto=format&fit=crop&q=80", available: true, featured: true },
    { id: "item_3", name: "Saucy Chicken Wrap", description: "Saucy chicken wrap with crispy chips & fresh salads.", price: 65, categoryId: "cat_wraps", imageUrl: "https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=600&auto=format&fit=crop&q=80", available: true, featured: false },
    { id: "item_4", name: "Watermelon & Passion Fruit Mocktail", description: "Fresh watermelon juice, passion fruit & sparkling soda.", price: 20, categoryId: "cat_mocktails", imageUrl: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?w=600&auto=format&fit=crop&q=80", available: true, featured: true },
    { id: "item_5", name: "Classic Rose Falooda", description: "Cardamom rose milk, falooda noodles, tukmaria & ice cream.", price: 30, categoryId: "cat_desserts", imageUrl: "https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=600&auto=format&fit=crop&q=80", available: true, featured: false }
  ]
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // CORS Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
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
    // -------------------------------------------------------------
    // GET: Public Menu OR Tracking OR Admin Dashboard Orders
    // -------------------------------------------------------------
    if (request.method === "GET") {
      const trackToken = url.searchParams.get("track");

      // 1. Order Tracking
      if (trackToken) {
        const orderId = await env.HONEYDEES_DB.get(`track:${trackToken}`);
        if (!orderId) return jsonResponse({ error: "Order not found" }, 404);
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        return jsonResponse(order);
      }

      // 2. Public Data Bootstrap
      let settings = await env.HONEYDEES_DB.get("settings", "json") || SEED_DATA.settings;
      let categories = await env.HONEYDEES_DB.get("categories", "json") || SEED_DATA.categories;
      let menu = await env.HONEYDEES_DB.get("menu", "json") || SEED_DATA.menu;

      let orders = [];
      if (isAdmin) {
        const index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        for (const id of index.slice(0, 150)) {
          const ord = await env.HONEYDEES_DB.get(`order:${id}`, "json");
          if (ord) orders.push(ord);
        }
      }

      return jsonResponse({
        authenticated: isAdmin,
        public: { settings, categories, menu },
        orders: isAdmin ? orders : undefined
      });
    }

    // -------------------------------------------------------------
    // POST: Orders, Uploads & Admin Updates
    // -------------------------------------------------------------
    if (request.method === "POST") {
      const body = await request.json();

      // Customer: Create New Order
      if (body.action === "createOrder") {
        const { customer, orderType, deliveryAddress, items, popBase64 } = body.data;

        const menu = await env.HONEYDEES_DB.get("menu", "json") || SEED_DATA.menu;
        const settings = await env.HONEYDEES_DB.get("settings", "json") || SEED_DATA.settings;
        const menuMap = new Map(menu.map(i => [i.id, i]));

        let subtotal = 0;
        const verifiedItems = [];
        for (const itm of items) {
          const srv = menuMap.get(itm.id);
          if (!srv || !srv.available) return jsonResponse({ error: `Unavailable: ${itm.name}` }, 400);
          const qty = Math.max(1, parseInt(itm.quantity, 10) || 1);
          const lineTotal = srv.price * qty;
          subtotal += lineTotal;
          verifiedItems.push({ id: srv.id, name: srv.name, price: srv.price, quantity: qty, lineTotal });
        }

        const deliveryFee = orderType === "DELIVERY" ? (Number(settings.deliveryFee) || 30) : 0;
        const total = subtotal + deliveryFee;
        const orderNumber = "HD-" + Math.floor(100000 + Math.random() * 900000);
        const trackingToken = crypto.randomUUID();

        const newOrder = {
          id: "ord_" + Date.now(),
          orderNumber,
          trackingToken,
          customer,
          orderType,
          deliveryAddress: deliveryAddress || "",
          items: verifiedItems,
          subtotal,
          deliveryFee,
          total,
          status: popBase64 ? "PAYMENT PROOF RECEIVED" : "AWAITING EFT PAYMENT",
          popBase64: popBase64 || null,
          createdAt: new Date().toLocaleDateString("en-GB") + " " + new Date().toLocaleTimeString("en-GB")
        };

        // Save order and tracking pointer in KV
        await env.HONEYDEES_DB.put(`order:${newOrder.id}`, JSON.stringify(newOrder));
        await env.HONEYDEES_DB.put(`track:${trackingToken}`, newOrder.id);

        let index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        index.unshift(newOrder.id);
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify(index.slice(0, 1000)));

        return jsonResponse({ success: true, trackingToken, orderNumber, total });
      }

      // Customer: Late Proof of Payment Upload
      if (body.action === "uploadLatePOP") {
        const { trackingToken, popBase64 } = body.data;
        const orderId = await env.HONEYDEES_DB.get(`track:${trackingToken}`);
        if (!orderId) return jsonResponse({ error: "Order not found" }, 404);

        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        order.popBase64 = popBase64;
        order.status = "PAYMENT PROOF RECEIVED";
        await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      // ADMIN ACTIONS (Require Password)
      if (!isAdmin) {
        return jsonResponse({ error: "Unauthorized access" }, 401);
      }

      if (body.action === "updateOrderStatus") {
        const { orderId, status } = body.data;
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        if (!order) return jsonResponse({ error: "Order not found" }, 404);
        order.status = status;
        await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
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
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
      }
