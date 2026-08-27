const SEED_DATA = {
  settings: {
    businessName: "Honeydees", halalBadge: "100% Strictly Halal", isStoreOpen: true, operatingDays: "Fridays Only",
    openTime: "14:00", closeTime: "21:30", closedNotice: "We are currently closed.", heroHeading: "Cape Town's Friday Night Treat",
    heroSubtitle: "Flame-grilled Masala steak sandwiches, saucy wraps & handcrafted mocktails.", scheduleNotice: "Collection: 14 Viola St, Lentegeur (From 6:00 PM)",
    collectionAddress: "14 Viola Street, Lentegeur", deliveryFee: 30, bankName: "Standard Bank", accountHolder: "Honeydees Food Enterprise", accountNumber: "10192837465", branchCode: "051001"
  },
  categories: [{ id: "cat_mains", name: "Main Meals" }, { id: "cat_wraps", name: "Wraps & Grills" }],
  menu: [{ id: "item_1", name: "Masala Steak Sandwich", description: "Masala steak cutlets & fresh salad.", price: 65, categoryId: "cat_mains", imageUrl: "", available: true, featured: true }]
};

async function sha256(b64) {
  const msg = new TextEncoder().encode(b64);
  const hash = await crypto.subtle.digest("SHA-256", msg);
  return Array.from(new Uint8Array(hash)).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
  }

  // BINARY ENDPOINT FOR MENU IMAGES
  if (request.method === "GET" && url.searchParams.get("image")) {
    const b64 = await env.HONEYDEES_DB.get("image:" + url.searchParams.get("image"));
    if (!b64) return new Response("Not found", { status: 404 });
    const match = b64.match(/^data:(.+);base64,(.*)$/);
    if (match) {
      const buffer = Uint8Array.from(atob(match[2]), function(c) { return c.charCodeAt(0); });
      return new Response(buffer, { headers: { "Content-Type": match[1], "Cache-Control": "public, max-age=31536000" }});
    }
    return new Response(b64);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const adminSecret = env.ADMIN_PASSWORD;
  if (!adminSecret) return jsonResponse({ error: "Server Configuration Error: Secret Missing." }, 500);
  const isAdmin = (authHeader === adminSecret);

  // 🛡️ DUAL-FALLBACK POP VIEWER ENDPOINT (Finds both new & legacy uploads)
  if (request.method === "GET" && url.searchParams.get("pop")) {
    if (!isAdmin) return jsonResponse({ error: "Unauthorized" }, 401);
    const tokenOrId = url.searchParams.get("pop");
    
    // 1. Check new isolated key
    let b64 = await env.HONEYDEES_DB.get("pop:" + tokenOrId);
    
    // 2. If not found, check legacy order object
    if (!b64) {
      let orderId = await env.HONEYDEES_DB.get("track:" + tokenOrId);
      if (!orderId) orderId = tokenOrId;
      const order = await env.HONEYDEES_DB.get("order:" + orderId, "json");
      if (order && order.popBase64) {
        b64 = order.popBase64;
      }
    }
    
    if (!b64) return jsonResponse({ error: "No receipt file found for this order." }, 404);
    return jsonResponse({ popBase64: b64 });
  }

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
      return jsonResponse({ authenticated: isAdmin, public: { settings: st, categories: ct, menu: mn }, orders: isAdmin ? orders : undefined });
    }

    if (request.method === "POST") {
      const body = await request.json();

      if (body.action === "createOrder") {
        const settings = (await env.HONEYDEES_DB.get("settings", "json")) || SEED_DATA.settings;
        const statusMode = settings.storeStatus || (settings.isStoreOpen === false ? "CLOSED" : "OPEN");
        if (statusMode === "CLOSED") return jsonResponse({ error: settings.closedNotice || "Store is closed." }, 400);

        const customer = body.data.customer;
        const orderType = body.data.orderType;
        const deliveryAddress = body.data.deliveryAddress;
        const items = body.data.items;

        if (!customer || !customer.name || !customer.phone) return jsonResponse({ error: "Name and phone required." }, 400);
        if (!items || items.length === 0) return jsonResponse({ error: "Cart is empty." }, 400);
        if (orderType === "DELIVERY" && (!deliveryAddress || !deliveryAddress.trim())) return jsonResponse({ error: "Delivery address required." }, 400);

        const menu = (await env.HONEYDEES_DB.get("menu", "json")) || SEED_DATA.menu;
        const menuMap = new Map(menu.map(function(item) { return [item.id, item]; }));
        let subtotal = 0;
        let verifiedItems = [];

        for (let i = 0; i < items.length; i++) {
          const itm = items[i];
          const s = menuMap.get(itm.id);
          if (!s || !s.available) return jsonResponse({ error: "Item unavailable: " + itm.name }, 400);
          const qty = Math.min(20, Math.max(1, parseInt(itm.quantity, 10) || 1));
          const lineTotal = s.price * qty;
          subtotal += lineTotal;
          verifiedItems.push({ id: s.id, name: s.name, price: s.price, quantity: qty, lineTotal: lineTotal });
        }

        const deliveryFee = (orderType === "DELIVERY") ? (Number(settings.deliveryFee) || 30) : 0;
        const total = subtotal + deliveryFee;
        
        let isUnique = false;
        let orderNumber = "";
        while (!isUnique) {
          orderNumber = "HNY" + Math.floor(100000 + Math.random() * 900000);
          const chk = await env.HONEYDEES_DB.get("ordernum:" + orderNumber);
          if (!chk) {
            await env.HONEYDEES_DB.put("ordernum:" + orderNumber, "1", { expirationTtl: 86400 * 30 });
            isUnique = true;
          }
        }
        
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

        const sizeBytes = Math.ceil((popBase64.length * 3) / 4);
        if (popBase64.includes("application/pdf") && sizeBytes > 2 * 1024 * 1024) return jsonResponse({ error: "PDF too large (Max 2MB)" }, 400);
        if (popBase64.includes("image/") && sizeBytes > 1024 * 1024) return jsonResponse({ error: "Image too large (Max 1MB)" }, 400);

        const orderId = await env.HONEYDEES_DB.get("track:" + trackingToken);
        if (!orderId) return jsonResponse({ error: "Order not found" }, 404);

        const hash = await sha256(popBase64);
        const dup = await env.HONEYDEES_DB.get("pophash:" + hash);
        if (dup && dup !== orderId) {
          return jsonResponse({ error: "⚠️ Duplicate Proof of Payment. This exact receipt file was already used on another order." }, 400);
        }

        const order = await env.HONEYDEES_DB.get("order:" + orderId, "json");
        if (!order) return jsonResponse({ error: "Order record not found" }, 404);

        order.popHash = hash;
        order.status = "PAYMENT UNDER REVIEW";
        order.paymentStatus = "REVIEW";

        await env.HONEYDEES_DB.put("pop:" + trackingToken, popBase64);
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
        order.popHash = null;
        await env.HONEYDEES_DB.delete("pop:" + order.trackingToken);
        await env.HONEYDEES_DB.put("order:" + orderId, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      if (body.action === "updateOrderStatus") {
        const orderId = body.data.orderId;
        const status = body.data.status;
        const order = await env.HONEYDEES_DB.get("order:" + orderId, "json");
        if (!order) return jsonResponse({ error: "Order not found" }, 404);

        if (["PREPARING", "READY", "COMPLETED"].includes(status) && order.paymentStatus !== "VERIFIED") {
          return jsonResponse({ error: "SERVER SECURITY BLOCK: Payment must be explicitly VERIFIED before preparing or fulfilling." }, 400);
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
            await env.HONEYDEES_DB.delete("pop:" + order.trackingToken);
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
            await env.HONEYDEES_DB.delete("pop:" + order.trackingToken);
            if (order.popHash) await env.HONEYDEES_DB.delete("pophash:" + order.popHash);
          }
        }
        await env.HONEYDEES_DB.put("index:orders", JSON.stringify([]));
        return jsonResponse({ success: true });
      }

      if (body.action === "adminSaveAll") {
        const settings = body.data.settings;
        const categories = body.data.categories;
        const menu = body.data.menu;
        if (settings) await env.HONEYDEES_DB.put("settings", JSON.stringify(settings));
        if (categories) await env.HONEYDEES_DB.put("categories", JSON.stringify(categories));
        if (menu) {
          for (let i = 0; i < menu.length; i++) {
            if (menu[i].imageUrl && menu[i].imageUrl.startsWith("data:")) {
              const sizeBytes = Math.ceil((menu[i].imageUrl.length * 3) / 4);
              if (sizeBytes > 500 * 1024) return jsonResponse({ error: "Image for " + menu[i].name + " exceeds 500KB limit." }, 400);
              await env.HONEYDEES_DB.put("image:" + menu[i].id, menu[i].imageUrl);
              menu[i].imageUrl = "/api/data?image=" + menu[i].id;
            }
          }
          await env.HONEYDEES_DB.put("menu", JSON.stringify(menu));
        }
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
