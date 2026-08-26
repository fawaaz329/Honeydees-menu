const SEED_DATA = {
  settings: {
    businessName: "Honeydees",
    halalBadge: "100% Strictly Halal",
    isStoreOpen: true,
    operatingDays: "Friday",
    openTime: "14:00",
    closeTime: "21:30",
    closedNotice: "We are currently closed. Next ordering window opens Friday at 2:00 PM.",
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
    {
      id: "item_1",
      name: "Masala Steak Sandwich",
      description: "Masala steak cutlets, slap chips & fresh salad.",
      price: 65,
      categoryId: "cat_mains",
      imageUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=600&auto=format&fit=crop&q=80",
      available: true,
      featured: true
    }
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
        if (!id) return jsonResponse({ error: "Order not found" }, 404);
        return jsonResponse(await env.HONEYDEES_DB.get(`order:${id}`, "json"));
      }

      let settings = await env.HONEYDEES_DB.get("settings", "json") || SEED_DATA.settings;
      let categories = await env.HONEYDEES_DB.get("categories", "json") || SEED_DATA.categories;
      let menu = await env.HONEYDEES_DB.get("menu", "json") || SEED_DATA.menu;
      let orders = [];

      if (isAdmin) {
        const index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        for (const id of index.slice(0, 200)) {
          const od = await env.HONEYDEES_DB.get(`order:${id}`, "json");
          if (od) orders.push(od);
        }
      }
      return jsonResponse({
        authenticated: isAdmin,
        public: { settings, categories, menu },
        orders: isAdmin ? orders : undefined
      });
    }

    if (request.method === "POST") {
      const body = await request.json();

      if (body.action === "createOrder") {
        const settings = await env.HONEYDEES_DB.get("settings", "json") || SEED_DATA.settings;
        
        // --- STRICT SAST TIME & DAY VALIDATION ---
        let isClosed = false;
        if (settings.isStoreOpen === false) {
          isClosed = true; // Manual force close
        } else {
          const d = new Date();
          const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
          const sast = new Date(utc + (3600000 * 2)); // SAST is UTC+2
          
          const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
          const currentDay = days[sast.getDay()].toLowerCase();
          const currentH = sast.getHours();
          const currentM = sast.getMinutes();
          const currentTimeStr = (currentH < 10 ? '0'+currentH : currentH) + ":" + (currentM < 10 ? '0'+currentM : currentM);
          
          const opDays = (settings.operatingDays || "Friday").toLowerCase();
          
          if (!opDays.includes(currentDay) && !opDays.includes("everyday") && !opDays.includes("all")) {
            isClosed = true; // Wrong Day
          } else if (settings.openTime && settings.closeTime) {
            if (currentTimeStr < settings.openTime || currentTimeStr > settings.closeTime) {
              isClosed = true; // Outside of operating hours
            }
          }
        }

        if (isClosed) {
          return jsonResponse({ error: settings.closedNotice || "Store is currently closed for orders." }, 400);
        }
        // -----------------------------------------

        const { customer, orderType, deliveryAddress, items, popBase64 } = body.data;

        if (!popBase64) return jsonResponse({ error: "Proof of Payment is strictly required." }, 400);
        if (orderType === "DELIVERY" && (!deliveryAddress || !deliveryAddress.trim())) {
          return jsonResponse({ error: "Delivery address is required for delivery orders." }, 400);
        }

        const menu = await env.HONEYDEES_DB.get("menu", "json") || SEED_DATA.menu;
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
          orderNumber,
          trackingToken,
          customer,
          orderType,
          deliveryAddress: deliveryAddress ? deliveryAddress.trim() : "",
          items: verifiedItems,
          subtotal,
          deliveryFee,
          total,
          status: "PAYMENT PROOF RECEIVED",
          popBase64,
          createdAt: new Date().toLocaleDateString("en-GB") + " " + new Date().toLocaleTimeString("en-GB")
        };

        await env.HONEYDEES_DB.put(`order:${newOrder.id}`, JSON.stringify(newOrder));
        await env.HONEYDEES_DB.put(`track:${trackingToken}`, newOrder.id);
        
        let index = await env.HONEYDEES_DB.get("index:orders", "json") || [];
        index.unshift(newOrder.id);
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify(index.slice(0, 1000)));

        return jsonResponse({ success: true, trackingToken, orderNumber, total });
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
        for (const id of index) {
          const order = await env.HONEYDEES_DB.get(`order:${id}`, "json");
          if (order && (order.status === "COMPLETED" || order.status === "CANCELLED")) {
            await env.HONEYDEES_DB.delete(`order:${id}`);
            await env.HONEYDEES_DB.delete(`track:${order.trackingToken}`);
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
