const SD = {
  settings: {
    businessName: "Honeydees", halalBadge: "100% Strictly Halal", isStoreOpen: true, operatingDays: "Fridays Only",
    openTime: "14:00", closeTime: "21:30", closedNotice: "We are currently closed.",
    heroHeading: "Cape Town's Friday Night Treat", heroSubtitle: "Flame-grilled Masala steak sandwiches, saucy wraps & handcrafted mocktails.",
    scheduleNotice: "Collection: 14 Viola St, Lentegeur (From 6:00 PM)", collectionAddress: "14 Viola Street, Lentegeur, Mitchells Plain",
    deliveryFee: 30, bankName: "Standard Bank", accountHolder: "Honeydees Food Enterprise", accountNumber: "10192837465", branchCode: "051001"
  },
  categories: [{ id: "cat_mains", name: "Main Meals" }, { id: "cat_wraps", name: "Wraps & Grills" }],
  menu: [{ id: "item_1", name: "Masala Steak Sandwich", description: "Masala steak cutlets & fresh salad.", price: 65, categoryId: "cat_mains", imageUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=600&auto=format&fit=crop&q=80", available: true, featured: true }]
};

async function sha256(b64) {
  const msg = new TextEncoder().encode(b64);
  const hash = await crypto.subtle.digest('SHA-256', msg);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
  }

  const ah = request.headers.get("Authorization") || "";
  const as = env.ADMIN_PASSWORD || "Honeydees2026!";
  const iA = ah === as;

  try {
    if (request.method === "GET") {
      const tk = url.searchParams.get("track");
      if (tk) {
        const id = await env.HONEYDEES_DB.get(`track:${tk}`);
        if (!id) return jsonResponse({ error: "Order not found" }, 404);
        const orderData = await env.HONEYDEES_DB.get(`order:${id}`, "json");
        orderData.settings = await env.HONEYDEES_DB.get("settings", "json") || SD.settings;
        return jsonResponse(orderData);
      }

      let st = await env.HONEYDEES_DB.get("settings", "json") || SD.settings;
      let ct = await env.HONEYDEES_DB.get("categories", "json") || SD.categories;
      let mn = await env.HONEYDEES_DB.get("menu", "json") || SD.menu;
      let orders = [];

      if (iA) {
        const ix = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        for (const id of ix.slice(0, 200)) {
          const od = await env.HONEYDEES_DB.get(`order:${id}`, "json");
          if (od) orders.push(od);
        }
      }
      return jsonResponse({ authenticated: iA, public: { settings: st, categories: ct, menu: mn }, orders: iA ? orders : undefined });
    }

    if (request.method === "POST") {
      const body = await request.json();

      if (body.action === "createOrder") {
        const settings = await env.HONEYDEES_DB.get("settings", "json") || SD.settings;
        if (settings.isStoreOpen === false) return jsonResponse({ error: settings.closedNotice || "Ordering is closed." }, 400);

        const { customer, orderType, deliveryAddress, items } = body.data;
        if (orderType === "DELIVERY" && (!deliveryAddress || !deliveryAddress.trim())) return jsonResponse({ error: "Delivery address required." }, 400);

        const menu = await env.HONEYDEES_DB.get("menu", "json") || SD.menu;
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
        const orderNumber = "HNY" + Math.floor(100000 + Math.random() * 900000);
        const trackingToken = crypto.randomUUID();

        const newOrder = {
          id: "ord_" + Date.now(),
          orderNumber, trackingToken, customer, orderType, deliveryAddress: deliveryAddress ? deliveryAddress.trim() : "",
          items: verifiedItems, subtotal, deliveryFee, total,
          status: "AWAITING PAYMENT", paymentStatus: "PENDING", popBase64: null, popHash: null,
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
        if (!popBase64) return jsonResponse({ error: "No file provided" }, 400);
        const orderId = await env.HONEYDEES_DB.get(`track:${trackingToken}`);
        if (!orderId) return jsonResponse({ error: "Not found" }, 404);
        
        const hash = await sha256(popBase64);
        const dup = await env.HONEYDEES_DB.get(`pophash:${hash}`);
        if (dup && dup !== orderId) {
          return jsonResponse({ error: "⚠️ Duplicate POP. This exact receipt has already been used for another order. Please upload a valid proof of payment." }, 400);
        }
        
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        order.popBase64 = popBase64;
        order.popHash = hash;
        order.status = "PAYMENT UNDER REVIEW";
        order.paymentStatus = "REVIEW";
        await env.HONEYDEES_DB.put(`pophash:${hash}`, orderId);
        await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (!iA) return jsonResponse({ error: "Unauthorized" }, 401);

      if (body.action === "verifyPayment") {
        const { orderId } = body.data;
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        order.paymentStatus = "VERIFIED";
        order.status = "PAYMENT VERIFIED";
        await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (body.action === "rejectPayment") {
        const { orderId } = body.data;
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        order.paymentStatus = "REJECTED";
        order.status = "PAYMENT REJECTED";
        if (order.popHash) await env.HONEYDEES_DB.delete(`pophash:${order.popHash}`);
        order.popBase64 = null;
        order.popHash = null;
        await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (body.action === "updateOrderStatus") {
        const { orderId, status } = body.data;
        const order = await env.HONEYDEES_DB.get(`order:${orderId}`, "json");
        if (!order) return jsonResponse({ error: "Not found" }, 404);
        
        if (['PREPARING', 'READY', 'COMPLETED'].includes(status) && order.paymentStatus !== "VERIFIED") {
          return jsonResponse({ error: "Server Enforced Error: Payment must be explicitly VERIFIED before fulfilling order." }, 400);
        }

        order.status = status;
        await env.HONEYDEES_DB.put(`order:${orderId}`, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (body.action === "clearCompletedOrders") {
        let index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        let newIndex = [];
        for (const id of index) {
          const order = await env.HONEYDEES_DB.get(`order:${id}`, "json");
          if (order && (order.status === "COMPLETED" || order.status === "CANCELLED")) {
            await env.HONEYDEES_DB.delete(`order:${id}`);
            await env.HONEYDEES_DB.delete(`track:${order.trackingToken}`);
            if (order.popHash) await env.HONEYDEES_DB.delete(`pophash:${order.popHash}`);
          } else {
            newIndex.push(id);
          }
        }
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify(newIndex));
        return jsonResponse({ success: true });
      }

      if (body.action === "resetSalesData") {
        let index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        for (const id of index) {
          const order = await env.HONEYDEES_DB.get(`order:${id}`, "json");
          if (order) {
            await env.HONEYDEES_DB.delete(`order:${id}`);
            await env.HONEYDEES_DB.delete(`track:${order.trackingToken}`);
            if (order.popHash) await env.HONEYDEES_DB.delete(`pophash:${order.popHash}`);
          }
        }
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify([]));
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
