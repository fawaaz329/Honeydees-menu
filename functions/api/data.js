const SEED_DATA = {
  settings: {
    businessName: "Honeydees",
    halalBadge: "100% Strictly Halal",
    isStoreOpen: true,
    operatingDays: "Friday",
    openTime: "14:00",
    closeTime: "21:30",
    closedNotice: "We are currently closed for orders. Next ordering window opens Friday at 2:00 PM.",
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
      description: "Masala steak cutlets, crispy slap chips & fresh salad.",
      price: 65,
      categoryId: "cat_mains",
      imageUrl: "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=600&auto=format&fit=crop&q=80",
      available: true,
      featured: true
    },
    {
      id: "item_2",
      name: "Full House Steak Sandwich",
      description: "Masala steak, fried egg, cheese, chips & salad.",
      price: 85,
      categoryId: "cat_mains",
      imageUrl: "https://images.unsplash.com/photo-1550547660-d9450f859349?w=600&auto=format&fit=crop&q=80",
      available: true,
      featured: true
    },
    {
      id: "item_3",
      name: "Saucy Chicken Wrap",
      description: "Flame-seared saucy chicken wrap with crispy chips & salads.",
      price: 65,
      categoryId: "cat_wraps",
      imageUrl: "https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=600&auto=format&fit=crop&q=80",
      available: true,
      featured: false
    },
    {
      id: "item_4",
      name: "Watermelon & Passion Fruit Mocktail",
      description: "Fresh crushed watermelon juice, passion fruit & sparkling soda.",
      price: 20,
      categoryId: "cat_mocktails",
      imageUrl: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?w=600&auto=format&fit=crop&q=80",
      available: true,
      featured: true
    },
    {
      id: "item_5",
      name: "Classic Rose Falooda",
      description: "Cardamom rose milk, falooda noodles, tukmaria & vanilla ice cream.",
      price: 30,
      categoryId: "cat_desserts",
      imageUrl: "https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=600&auto=format&fit=crop&q=80",
      available: true,
      featured: false
    }
  ]
};

async function sha256(b64) {
  const msg = new TextEncoder().encode(b64);
  const hash = await crypto.subtle.digest("SHA-256", msg);
  return Array.from(new Uint8Array(hash))
    .map(function(b) { return b.toString(16).padStart(2, "0"); })
    .join("");
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
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
  const isAdmin = (authHeader === adminSecret);

  try {
    if (request.method === "GET") {
      const trackToken = url.searchParams.get("track");
      if (trackToken) {
        const id = await env.HONEYDEES_DB.get("track:" + trackToken);
        if (!id) return jsonResponse({ error: "Order not found" }, 404);
        const orderData = await env.HONEYDEES_DB.get("order:" + id, "json");
        if (!orderData) return jsonResponse({ error: "Order record missing" }, 404);
        orderData.settings = (await env.HONEYDEES_DB.get("settings", "json")) || SEED_DATA.settings;
        return jsonResponse(orderData);
      }

      const st = (await env.HONEYDEES_DB.get("settings", "json")) || SEED_DATA.settings;
      const ct = (await env.HONEYDEES_DB.get("categories", "json")) || SEED_DATA.categories;
      const mn = (await env.HONEYDEES_DB.get("menu", "json")) || SEED_DATA.menu;
      let orders = [];

      if (isAdmin) {
        const index = (await env.HONEYDEES_DB.get("index:orders", "json")) || [];
        for (let i = 0; i < Math.min(index.length, 200); i++) {
          const od = await env.HONEYDEES_DB.get("order:" + index[i], "json");
          if (od) orders.push(od);
        }
      }

      return jsonResponse({
        authenticated: isAdmin,
        public: { settings: st, categories: ct, menu: mn },
        orders: isAdmin ? orders : undefined
      });
    }

    if (request.method === "POST") {
      const body = await request.json();

      if (body.action === "createOrder") {
        const settings = (await env.HONEYDEES_DB.get("settings", "json")) || SEED_DATA.settings;

        let isClosed = false;
        if (settings.isStoreOpen === false) {
          isClosed = true;
        } else {
          const d = new Date();
          const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
          const sast = new Date(utc + (3600000 * 2));
          const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
          const currentDay = days[sast.getDay()];
          const currentH = sast.getHours();
          const currentM = sast.getMinutes();
          const currentTimeStr = (currentH < 10 ? "0" + currentH : currentH) + ":" + (currentM < 10 ? "0" + currentM : currentM);
          const opDays = (settings.operatingDays || "Friday").toLowerCase();

          if (!opDays.includes(currentDay) && !opDays.includes("everyday") && !opDays.includes("all")) {
            isClosed = true;
          } else if (settings.openTime && settings.closeTime) {
            if (currentTimeStr < settings.openTime || currentTimeStr > settings.closeTime) {
              isClosed = true;
            }
          }
        }

        if (isClosed) {
          return jsonResponse({ error: settings.closedNotice || "Store is currently closed for orders." }, 400);
        }

        const customer = body.data.customer;
        const orderType = body.data.orderType;
        const deliveryAddress = body.data.deliveryAddress;
        const items = body.data.items;

        if (orderType === "DELIVERY" && (!deliveryAddress || !deliveryAddress.trim())) {
          return jsonResponse({ error: "Delivery address is required for delivery orders." }, 400);
        }

        const menu = (await env.HONEYDEES_DB.get("menu", "json")) || SEED_DATA.menu;
        const menuMap = new Map(menu.map(function(item) { return [item.id, item]; }));
        let subtotal = 0;
        let verifiedItems = [];

        for (let i = 0; i < items.length; i++) {
          const itm = items[i];
          const s = menuMap.get(itm.id);
          if (!s || !s.available) return jsonResponse({ error: "Item unavailable: " + itm.name }, 400);
          const qty = Math.max(1, parseInt(itm.quantity, 10) || 1);
          const lineTotal = s.price * qty;
          subtotal += lineTotal;
          verifiedItems.push({ id: s.id, name: s.name, price: s.price, quantity: qty, lineTotal: lineTotal });
        }

        const deliveryFee = (orderType === "DELIVERY") ? (Number(settings.deliveryFee) || 30) : 0;
        const total = subtotal + deliveryFee;
        const orderNumber = "HNY" + Math.floor(100000 + Math.random() * 900000);
        const trackingToken = crypto.randomUUID();

        const newOrder = {
          id: "ord_" + Date.now(),
          orderNumber: orderNumber,
          trackingToken: trackingToken,
          customer: customer,
          orderType: orderType,
          deliveryAddress: deliveryAddress ? deliveryAddress.trim() : "",
          items: verifiedItems,
          subtotal: subtotal,
          deliveryFee: deliveryFee,
          total: total,
          status: "AWAITING PAYMENT",
          paymentStatus: "PENDING",
          popBase64: null,
          popHash: null,
          createdAt: new Date().toLocaleDateString("en-GB") + " " + new Date().toLocaleTimeString("en-GB")
        };

        await env.HONEYDEES_DB.put("order:" + newOrder.id, JSON.stringify(newOrder));
        await env.HONEYDEES_DB.put("track:" + trackingToken, newOrder.id);

        let index = (await env.HONEYDEES_DB.get("index:orders", "json")) || [];
        index.unshift(newOrder.id);
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify(index.slice(0, 1000)));

        return jsonResponse({ success: true, trackingToken: trackingToken, orderNumber: orderNumber, total: total });
      }

      if (body.action === "uploadLatePOP") {
        const trackingToken = body.data.trackingToken;
        const popBase64 = body.data.popBase64;
        if (!popBase64) return jsonResponse({ error: "No receipt file provided" }, 400);

        const orderId = await env.HONEYDEES_DB.get("track:" + trackingToken);
        if (!orderId) return jsonResponse({ error: "Order not found" }, 404);

        const hash = await sha256(popBase64);
        const dup = await env.HONEYDEES_DB.get("pophash:" + hash);
        if (dup && dup !== orderId) {
          return jsonResponse({ error: "⚠️ Duplicate POP. This exact receipt file was already used on another order." }, 400);
        }

        const order = await env.HONEYDEES_DB.get("order:" + orderId, "json");
        if (!order) return jsonResponse({ error: "Order record not found" }, 404);

        order.popBase64 = popBase64;
        order.popHash = hash;
        order.status = "PAYMENT UNDER REVIEW";
        order.paymentStatus = "REVIEW";

        await env.HONEYDEES_DB.put("pophash:" + hash, orderId);
        await env.HONEYDEES_DB.put("order:" + orderId, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (!isAdmin) return jsonResponse({ error: "Unauthorized access" }, 401);

      if (body.action === "verifyPayment") {
        const orderId = body.data.orderId;
        const order = await env.HONEYDEES_DB.get("order:" + orderId, "json");
        if (!order) return jsonResponse({ error: "Order not found" }, 404);
        order.paymentStatus = "VERIFIED";
        order.status = "PAYMENT VERIFIED";
        await env.HONEYDEES_DB.put("order:" + orderId, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (body.action === "rejectPayment") {
        const orderId = body.data.orderId;
        const order = await env.HONEYDEES_DB.get("order:" + orderId, "json");
        if (!order) return jsonResponse({ error: "Order not found" }, 404);
        order.paymentStatus = "REJECTED";
        order.status = "PAYMENT REJECTED";
        if (order.popHash) await env.HONEYDEES_DB.delete("pophash:" + order.popHash);
        order.popBase64 = null;
        order.popHash = null;
        await env.HONEYDEES_DB.put("order:" + orderId, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (body.action === "updateOrderStatus") {
        const orderId = body.data.orderId;
        const status = body.data.status;
        const order = await env.HONEYDEES_DB.get("order:" + orderId, "json");
        if (!order) return jsonResponse({ error: "Order not found" }, 404);

        if (["PREPARING", "READY", "COMPLETED"].includes(status) && order.paymentStatus !== "VERIFIED") {
          return jsonResponse({ error: "Security Restriction: Payment must be strictly VERIFIED before preparing or fulfilling." }, 400);
        }

        order.status = status;
        await env.HONEYDEES_DB.put("order:" + orderId, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (body.action === "clearCompletedOrders") {
        let index = (await env.HONEYDEES_DB.get("index:orders", "json")) || [];
        let newIndex = [];
        for (let i = 0; i < index.length; i++) {
          const id = index[i];
          const order = await env.HONEYDEES_DB.get("order:" + id, "json");
          if (order && (order.status === "COMPLETED" || order.status === "CANCELLED")) {
            await env.HONEYDEES_DB.delete("order:" + id);
            await env.HONEYDEES_DB.delete("track:" + order.trackingToken);
            if (order.popHash) await env.HONEYDEES_DB.delete("pophash:" + order.popHash);
          } else {
            newIndex.push(id);
          }
        }
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify(newIndex));
        return jsonResponse({ success: true });
      }

      if (body.action === "resetSalesData") {
        let index = (await env.HONEYDEES_DB.get("index:orders", "json")) || [];
        for (let i = 0; i < index.length; i++) {
          const id = index[i];
          const order = await env.HONEYDEES_DB.get("order:" + id, "json");
          if (order) {
            await env.HONEYDEES_DB.delete("order:" + id);
            await env.HONEYDEES_DB.delete("track:" + order.trackingToken);
            if (order.popHash) await env.HONEYDEES_DB.delete("pophash:" + order.popHash);
          }
        }
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify([]));
        return jsonResponse({ success: true });
      }

      if (body.action === "adminSaveAll") {
        const settings = body.data.settings;
        const menu = body.data.menu;
        const categories = body.data.categories;
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

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
          }
