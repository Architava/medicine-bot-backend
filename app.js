// app.js
// Main backend file for the Medicine Distribution Automation System

// =================================================================
// 1. DEPENDENCY IMPORTS
// =================================================================
const express = require('express');
const { Sequelize, DataTypes, Op } = require('sequelize');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const cron = require('node-cron');
const Fuse = require('fuse.js');
// We will use node-fetch for compatibility, though modern Node has fetch built-in
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));


// =================================================================
// 2. CONFIGURATION & INITIALIZATION
// =================================================================
require('dotenv').config();

const {
    DATABASE_URL,
    TELEGRAM_BOT_TOKEN,
    GEMINI_API_KEY, // <-- ADD THIS TO YOUR .env FILE
    PORT = 3001,
    VERCEL_URL
} = process.env;

if (!DATABASE_URL || !TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY) {
    console.error("FATAL ERROR: DATABASE_URL, TELEGRAM_BOT_TOKEN, and GEMINI_API_KEY must be set.");
    process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    protocol: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: false
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const WEBHOOK_URL = `https://${VERCEL_URL}/api/webhook`;
bot.setWebHook(WEBHOOK_URL);
console.log(`Webhook set to ${WEBHOOK_URL}`);

// // Use this for local development:
// const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });


// =================================================================
// 3. DATABASE MODELS (SEQUELIZE) - (No changes here)
// =================================================================

// --- Shopkeeper Model ---
const Shopkeeper = sequelize.define('Shopkeeper', {
    name: { type: DataTypes.STRING, allowNull: false },
    telegram_id: { type: DataTypes.BIGINT, allowNull: false, unique: true },
    address: { type: DataTypes.TEXT }
});
// --- Medicine Model ---
const Medicine = sequelize.define('Medicine', {
    name: { type: DataTypes.STRING, allowNull: false, unique: true },
    quantity_available: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0.00 }
});
// --- Order Model ---
const Order = sequelize.define('Order', {
    delivery_status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'Pending' },
    delivery_time: { type: DataTypes.DATE },
    total_amount: { type: DataTypes.DECIMAL(10, 2) }
});
// --- OrderItems (Junction Table) ---
const OrderItem = sequelize.define('OrderItem', {
    quantity: { type: DataTypes.INTEGER, allowNull: false },
    price_per_unit: { type: DataTypes.DECIMAL(10, 2), allowNull: false }
});

// --- Model Associations ---
Shopkeeper.hasMany(Order, { foreignKey: 'shopkeeper_id' });
Order.belongsTo(Shopkeeper, { foreignKey: 'shopkeeper_id' });

Order.hasMany(OrderItem, { foreignKey: 'order_id' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id' });

Medicine.hasMany(OrderItem, { foreignKey: 'medicine_id' });
OrderItem.belongsTo(Medicine, { foreignKey: 'medicine_id' });


// =================================================================
// 4. BOT LOGIC & HELPERS - FULL IMPLEMENTATION
// =================================================================
const userState = {};
let medicineFuse;
async function updateFuseSearch() {
    const medicines = await Medicine.findAll({ attributes: ['name'] });
    medicineFuse = new Fuse(medicines.map(m => m.name), { includeScore: true, threshold: 0.4 });
    console.log("Fuse.js search index updated.");
}

const withAuth = (handler) => async (msg, ...args) => {
    const chatId = msg.chat.id;
    const shopkeeper = await Shopkeeper.findOne({ where: { telegram_id: chatId } });
    if (!shopkeeper) {
        bot.sendMessage(chatId, "❌ Access Denied. Your Telegram ID is not registered. Please contact the administrator.");
        return;
    }
    return handler(msg, shopkeeper, ...args);
};

// --- /start ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const shopkeeper = await Shopkeeper.findOne({ where: { telegram_id: chatId } });
    if (!shopkeeper) {
        bot.sendMessage(chatId, "❌ Access Denied. Your Telegram ID is not registered. Please contact the administrator.");
        return;
    }
    bot.sendMessage(chatId, `👋 Welcome, ${shopkeeper.name}!\n\nYou can use the following commands:\n/order - Place a new order\n/inventory - View available medicines\n/history - View your past orders\n/feedback - Send feedback`);
});

// --- /inventory ---
bot.onText(/\/inventory/, withAuth(async (msg) => {
    const chatId = msg.chat.id;
    const medicines = await Medicine.findAll({ order: [['name', 'ASC']] });
    if (!medicines.length) {
        bot.sendMessage(chatId, "No medicines available in inventory.");
        return;
    }
    let text = '📦 *Available Medicines:*\n';
    medicines.forEach(med => {
        text += `• ${med.name}: ${med.quantity_available} units @ ₹${med.price}\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}));

// --- /order ---
bot.onText(/\/order/, withAuth(async (msg, shopkeeper) => {
    const chatId = msg.chat.id;
    userState[chatId] = { step: 'awaiting_medicine', order: [] };
    bot.sendMessage(chatId, "📝 Please enter the medicine name and quantity (e.g., Paracetamol,10). For bulk orders, send a list: Paracetamol,10;Amoxicillin,5");
}));

bot.on('message', withAuth(async (msg, shopkeeper) => {
    const chatId = msg.chat.id;
    if (!userState[chatId] || !msg.text || msg.text.startsWith('/')) return;
    const state = userState[chatId];
    if (state.step === 'awaiting_medicine') {
        // Parse input (single or bulk)
        let items = msg.text.split(';').map(s => s.trim()).filter(Boolean);
        let orderItems = [];
        let errors = [];
        for (let item of items) {
            let [name, qty] = item.split(',').map(s => s.trim());
            if (!name || !qty || isNaN(qty)) {
                errors.push(`Invalid format: ${item}`);
                continue;
            }
            // Fuzzy search for medicine name
            let med = await Medicine.findOne({ where: { name: { [Op.iLike]: name } } });
            if (!med && medicineFuse) {
                let result = medicineFuse.search(name);
                if (result.length > 0) {
                    med = await Medicine.findOne({ where: { name: result[0].item } });
                }
            }
            if (!med) {
                errors.push(`Medicine not found: ${name}`);
                continue;
            }
            if (med.quantity_available < parseInt(qty)) {
                errors.push(`Not enough stock for ${med.name} (Available: ${med.quantity_available})`);
                continue;
            }
            orderItems.push({ medicine: med, quantity: parseInt(qty) });
        }
        if (errors.length) {
            bot.sendMessage(chatId, `❌ Errors:\n${errors.join('\n')}`);
            return;
        }
        if (!orderItems.length) {
            bot.sendMessage(chatId, "No valid medicines in your order. Please try again.");
            return;
        }
        // Show summary and ask for confirmation
        let summary = '🛒 *Order Summary:*\n';
        let total = 0;
        orderItems.forEach(item => {
            summary += `• ${item.medicine.name}: ${item.quantity} x ₹${item.medicine.price} = ₹${(item.quantity * item.medicine.price).toFixed(2)}\n`;
            total += item.quantity * item.medicine.price;
        });
        summary += `\n*Total: ₹${total.toFixed(2)}*`;
        userState[chatId].order = orderItems;
        userState[chatId].step = 'awaiting_confirmation';
        bot.sendMessage(chatId, summary, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Confirm', callback_data: 'confirm_order' },
                        { text: '✏️ Edit', callback_data: 'edit_order' }
                    ]
                ]
            }
        });
    }
}));

// --- Inline button handlers for order confirmation ---
bot.on('callback_query', withAuth(async (query, shopkeeper) => {
    const chatId = query.message.chat.id;
    const state = userState[chatId];
    if (!state) return;
    if (query.data === 'confirm_order' && state.order && state.order.length) {
        // Create order in DB
        const t = await sequelize.transaction();
        try {
            const order = await Order.create({
                shopkeeper_id: shopkeeper.id,
                delivery_status: 'Pending',
                delivery_time: null,
                total_amount: state.order.reduce((sum, item) => sum + item.quantity * item.medicine.price, 0)
            }, { transaction: t });
            for (let item of state.order) {
                await OrderItem.create({
                    order_id: order.id,
                    medicine_id: item.medicine.id,
                    quantity: item.quantity,
                    price_per_unit: item.medicine.price
                }, { transaction: t });
                // Update stock
                item.medicine.quantity_available -= item.quantity;
                await item.medicine.save({ transaction: t });
                // Low stock notification
                if (item.medicine.quantity_available < 10) {
                    bot.sendMessage(chatId, `⚠️ Low stock alert for ${item.medicine.name}: ${item.medicine.quantity_available} units left.`);
                }
            }
            await t.commit();
            bot.sendMessage(chatId, '✅ Order placed successfully!');
            delete userState[chatId];
            await updateFuseSearch();
        } catch (err) {
            await t.rollback();
            bot.sendMessage(chatId, '❌ Failed to place order. Please try again.');
        }
    } else if (query.data === 'edit_order') {
        userState[chatId].step = 'awaiting_medicine';
        bot.sendMessage(chatId, '✏️ Please re-enter your order (e.g., Paracetamol,10;Amoxicillin,5)');
    }
    bot.answerCallbackQuery(query.id);
}));

// --- /history ---
bot.onText(/\/history/, withAuth(async (msg, shopkeeper) => {
    const chatId = msg.chat.id;
    const orders = await Order.findAll({
        where: { shopkeeper_id: shopkeeper.id },
        include: [{ model: OrderItem, include: [Medicine] }],
        order: [['createdAt', 'DESC']],
        limit: 10
    });
    if (!orders.length) {
        bot.sendMessage(chatId, 'No past orders found.');
        return;
    }
    let text = '*Your Last 10 Orders:*\n';
    orders.forEach(order => {
        text += `\nOrder #${order.id} (${order.createdAt.toLocaleString()}):\n`;
        order.OrderItems.forEach(item => {
            text += `- ${item.Medicine.name}: ${item.quantity} x ₹${item.price_per_unit}\n`;
        });
        text += `Status: ${order.delivery_status}\n`;
    });
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}));

// --- /feedback ---
bot.onText(/\/feedback/, withAuth(async (msg) => {
    const chatId = msg.chat.id;
    userState[chatId] = { step: 'awaiting_feedback' };
    bot.sendMessage(chatId, '📝 Please type your feedback.');
}));

bot.on('message', withAuth(async (msg, shopkeeper) => {
    const chatId = msg.chat.id;
    if (!userState[chatId] || userState[chatId].step !== 'awaiting_feedback' || !msg.text || msg.text.startsWith('/')) return;
    // Store feedback (could be in DB or email to admin)
    // For demo, just log
    console.log(`Feedback from ${shopkeeper.name} (${shopkeeper.telegram_id}): ${msg.text}`);
    bot.sendMessage(chatId, '🙏 Thank you for your feedback!');
    delete userState[chatId];
}));

// --- Delivery Scheduling (ask for delivery time after order confirmation) ---
// (You can expand this logic as needed)

// --- Automated Reminders (10 PM) ---
cron.schedule('0 22 * * *', async () => {
    const today = new Date();
    today.setHours(0,0,0,0);
    const orderedShopkeepers = await Order.findAll({
        where: { createdAt: { [Op.gte]: today } },
        attributes: ['shopkeeper_id'],
        group: ['shopkeeper_id']
    });
    const orderedIds = orderedShopkeepers.map(o => o.shopkeeper_id);
    const allShopkeepers = await Shopkeeper.findAll();
    for (let sk of allShopkeepers) {
        if (!orderedIds.includes(sk.id)) {
            bot.sendMessage(sk.telegram_id, '⏰ Reminder: You have not placed your medicine order today. Please order before midnight.');
        }
    }
}, { timezone: 'Asia/Kolkata' });


// =================================================================
// 5. API ENDPOINTS FOR ADMIN PANEL
// =================================================================

app.post('/api/webhook', (req, res) => { /* ... */ });
app.get('/api/orders', async (req, res) => { /* ... */ });
app.get('/api/medicines', async (req, res) => { /* ... */ });
app.patch('/api/medicines/:id', async (req, res) => { /* ... */ });
app.patch('/api/orders/:id', async (req, res) => { /* ... */ });
app.get('/api/analytics', async (req, res) => { /* ... */ });
// Copy API endpoints from the previous version
// ... (The existing API endpoints are unchanged)
// --- Webhook endpoint for Telegram ---
app.post('/api/webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});
// --- Get all orders ---
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await Order.findAll({
            include: [
                { model: Shopkeeper, attributes: ['name'] },
                { model: OrderItem, include: [{ model: Medicine, attributes: ['name'] }] }
            ],
            order: [['createdAt', 'DESC']]
        });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// --- Get all medicines ---
app.get('/api/medicines', async (req, res) => {
    try {
        const medicines = await Medicine.findAll({ order: [['name', 'ASC']] });
        res.json(medicines);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// --- Update medicine stock ---
app.patch('/api/medicines/:id', async (req, res) => { /* ... */ });
// --- Update order status ---
app.patch('/api/orders/:id', async (req, res) => { /* ... */ });
// --- Get analytics data ---
app.get('/api/analytics', async (req, res) => { /* ... */ });


// =================================================================
// 6. ✨ NEW: GEMINI API ENDPOINT
// =================================================================

app.post('/api/gemini/generate', async (req, res) => {
    const { prompt, context } = req.body;

    if (!prompt || !context) {
        return res.status(400).json({ error: 'Prompt and context are required.' });
    }

    // Construct the full prompt for the Gemini API
    const fullPrompt = `${prompt}\n\nHere is the data to analyze:\n\n${JSON.stringify(context, null, 2)}`;

    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    try {
        const apiResponse = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: fullPrompt }]
                }]
            })
        });

        if (!apiResponse.ok) {
            const errorBody = await apiResponse.text();
            console.error("Gemini API Error:", errorBody);
            throw new Error(`Gemini API request failed with status ${apiResponse.status}`);
        }

        const result = await apiResponse.json();
        
        if (result.candidates && result.candidates.length > 0 && result.candidates[0].content.parts.length > 0) {
            const text = result.candidates[0].content.parts[0].text;
            res.json({ text });
        } else {
            // Handle cases where the response structure is unexpected
            console.error("Unexpected Gemini API response structure:", result);
            res.status(500).json({ error: 'Could not extract content from Gemini response.' });
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error);
        res.status(500).json({ error: `Failed to get response from AI. ${error.message}` });
    }
});


// =================================================================
// 7. SERVER STARTUP
// =================================================================
async function startServer() {
    try {
        await sequelize.authenticate();
        console.log('✅ Database connection has been established successfully.');
        await sequelize.sync({ alter: true });
        console.log('✅ All models were synchronized successfully.');
        await updateFuseSearch();
        app.listen(PORT, () => {
            console.log(`🚀 Server is running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('❌ Unable to start the server:', error);
        process.exit(1);
    }
}

startServer();

module.exports = app;
