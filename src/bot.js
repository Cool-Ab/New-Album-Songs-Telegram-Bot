require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const connectDatabase = require("./config/database");
const User = require("./models/User");
const Payment = require("./models/Payment");

const bot = new Telegraf(process.env.BOT_TOKEN);
const paymentSessions = new Map();

function isAdmin(telegramId) {
  return [
    process.env.ADMIN_TELEGRAM_ID_1,
    process.env.ADMIN_TELEGRAM_ID_2,
    process.env.ADMIN_TELEGRAM_ID_3,
  ].includes(String(telegramId));
}

function getAdminUsername(ctx) {
  const id = String(ctx.from.id);

  if (id === String(process.env.ADMIN_TELEGRAM_ID_3)) {
    return process.env.ADMIN_3_SHOW_AS || "Admin";
  }

  if (ctx.from.username) {
    return `@${ctx.from.username}`;
  }

  return `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
}

function getSession(chatId) {
  const id = String(chatId);

  if (!paymentSessions.has(id)) {
    paymentSessions.set(id, { step: null, reference: null, lastMessageId: null });
  }

  return paymentSessions.get(id);
}

async function deleteLastPrompt(ctx, session) {
  if (!session.lastMessageId) return;

  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, session.lastMessageId);
  } catch (error) {
    console.log("Could not delete previous prompt:", error.message);
  }

  session.lastMessageId = null;
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💳 Subscribe", "subscribe")],
    [
      Markup.button.callback("🎵 My Subscription", "my_subscription"),
      Markup.button.callback("ℹ️ How It Works", "how_it_works"),
    ],
  ]);
}

async function sendMainMenu(ctx) {
  const telegramId = String(ctx.from.id);
  const session = getSession(telegramId);

  await deleteLastPrompt(ctx, session);

  const message = await ctx.reply(
    "🎵 Welcome to Premium Church Songs!\n\n" +
      "Enjoy access to our premium collection of church songs.\n\n" +
      "Subscription Status: ⏳ Not Active\n\n" +
      "What would you like to do?",
    mainMenu()
  );

  session.lastMessageId = message.message_id;
}

async function startPayment(ctx) {
  const telegramId = String(ctx.from.id);
  const session = getSession(telegramId);

  session.step = "payment_info";
  session.reference = null;

  await deleteLastPrompt(ctx, session);

  const details =
    "💳 Subscription\n\n" +
    `Monthly subscription: ${process.env.SUBSCRIPTION_PRICE} ETB\n\n` +
    "Please make your payment using the following account:\n\n" +
    `🏦 Bank: ${process.env.BANK_NAME}\n` +
    `👤 Account Name: ${process.env.ACCOUNT_NAME}\n` +
    `🔢 Account Number: ${process.env.ACCOUNT_NUMBER}\n\n` +
    "After payment, choose the next option below.";

  const message = await ctx.reply(
    details,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ I have paid", "payment_paid")],
      [Markup.button.callback("❌ Cancel", "cancel_payment")],
    ])
  );

  session.lastMessageId = message.message_id;
}

async function completePaymentSubmission(ctx, telegramId, session) {
  const photos = ctx.message.photo;
  const largestPhoto = photos[photos.length - 1];

  const payment = await Payment.create({
    telegramId,
    amount: Number(process.env.SUBSCRIPTION_PRICE),
    reference: session.reference,
    receiptFileId: largestPhoto.file_id,
    status: "pending",
  });

  const adminIds = [
    process.env.ADMIN_TELEGRAM_ID_1,
    process.env.ADMIN_TELEGRAM_ID_2,
    process.env.ADMIN_TELEGRAM_ID_3,
  ];

  const adminMessages = [];

  for (const adminId of adminIds) {
    const adminMessage = await bot.telegram.sendPhoto(adminId, largestPhoto.file_id, {
      caption:
        "💰 NEW PAYMENT\n\n" +
        `👤 User: ${ctx.from.first_name || ""} ${ctx.from.last_name || ""}\n` +
        `🆔 Telegram ID: ${telegramId}\n` +
        `👤 Username: @${ctx.from.username || "N/A"}\n\n` +
        `💵 Amount: ${payment.amount} ETB\n` +
        `🔖 Reference: ${payment.reference}\n\n` +
        "⏳ Status: Pending",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve_payment:${payment._id}` },
            { text: "❌ Reject", callback_data: `reject_payment:${payment._id}` },
          ],
        ],
      },
    });

    adminMessages.push({
      adminId: String(adminId),
      messageId: adminMessage.message_id,
    });
  }

  payment.adminMessages = adminMessages;
  await payment.save();

  paymentSessions.delete(telegramId);

  await ctx.reply(
    "✅ Payment submitted successfully!\n\n" +
      `🔖 Reference: ${payment.reference}\n` +
      `💵 Amount: ${payment.amount} ETB\n\n` +
      "⏳ Your payment is now waiting for verification.\n\n" +
      "You will receive a notification once it has been reviewed."
  );
}

async function startBot() {
  try {
    console.log("Connecting to MongoDB...");
    await connectDatabase();

    const botInfo = await bot.telegram.getMe();
    console.log(`Connected to Telegram as @${botInfo.username}`);

    bot.start(async (ctx) => {
      try {
        const telegramId = String(ctx.from.id);

        let user = await User.findOne({ telegramId });

        if (!user) {
          user = await User.create({
            telegramId,
            username: ctx.from.username || null,
            firstName: ctx.from.first_name || null,
            lastName: ctx.from.last_name || null,
            status: "pending",
          });
        } else {
          user.username = ctx.from.username || null;
          user.firstName = ctx.from.first_name || null;
          user.lastName = ctx.from.last_name || null;
          await user.save();
        }

        await sendMainMenu(ctx);
      } catch (error) {
        console.error("Error processing /start:", error);
        await ctx.reply("❌ Something went wrong while creating your account.\n\nPlease try again later.");
      }
    });

    bot.action("subscribe", async (ctx) => {
      await ctx.answerCbQuery();
      await startPayment(ctx);
    });

    bot.action("payment_paid", async (ctx) => {
      await ctx.answerCbQuery();

      const telegramId = String(ctx.from.id);
      const session = getSession(telegramId);
      session.step = "waiting_for_reference";

      await deleteLastPrompt(ctx, session);
      const message = await ctx.reply(
        "✅ Please enter your payment reference number.",
        Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "cancel_payment")]])
      );
      session.lastMessageId = message.message_id;
    });

    bot.action("cancel_payment", async (ctx) => {
      await ctx.answerCbQuery("Payment cancelled");
      const telegramId = String(ctx.from.id);
      const session = getSession(telegramId);

      await deleteLastPrompt(ctx, session);
      paymentSessions.delete(telegramId);
      await sendMainMenu(ctx);
    });

    bot.on("text", async (ctx) => {
      try {
        const telegramId = String(ctx.from.id);
        const session = paymentSessions.get(telegramId);

        if (!session) {
          return;
        }

        if (session.step === "waiting_for_reference") {
          const reference = ctx.message.text.trim();

          if (!reference || reference.length < 3) {
            await ctx.reply("❌ That doesn't look like a valid payment reference. Please enter a valid one.");
            return;
          }

          session.reference = reference;
          session.step = "waiting_for_receipt";

          await deleteLastPrompt(ctx, session);
          const message = await ctx.reply(
            "✅ Payment reference received.\n\n" +
              `🔖 Reference: ${reference}\n\n` +
              "Now please send your payment receipt screenshot/photo."
          );
          session.lastMessageId = message.message_id;
          return;
        }

        if (session.step === "waiting_for_receipt") {
          await ctx.reply("📸 Please send your payment receipt as an image, not text.");
          return;
        }
      } catch (error) {
        console.error("Error processing payment text:", error);
      }
    });

    bot.on("photo", async (ctx) => {
      try {
        const telegramId = String(ctx.from.id);
        const session = paymentSessions.get(telegramId);

        if (!session) {
          await ctx.reply("ℹ️ You don't currently have a payment process in progress.\n\nPlease click 💳 Subscribe to start a payment.");
          return;
        }

        if (session.step !== "waiting_for_receipt") {
          await ctx.reply("❌ Please send your payment reference first, then upload the receipt.");
          return;
        }

        await completePaymentSubmission(ctx, telegramId, session);
      } catch (error) {
        console.error("Error processing receipt:", error);
        await ctx.reply("❌ We couldn't submit your payment.\n\nPlease try again.");
      }
    });

    bot.action(/^approve_payment:(.+)$/, async (ctx) => {
      try {
        if (!isAdmin(ctx.from.id)) {
          await ctx.answerCbQuery("❌ You are not authorized.", { show_alert: true });
          return;
        }

        await ctx.answerCbQuery("Processing approval...");

        const paymentId = ctx.match[1];
        const payment = await Payment.findById(paymentId);

        if (!payment) {
          await ctx.reply("❌ Payment not found.");
          return;
        }

        if (payment.status !== "pending") {
          await ctx.reply(`⚠️ This payment has already been ${payment.status}.`);
          return;
        }

        payment.status = "approved";
        payment.verifiedAt = new Date();
        payment.verifiedBy = String(ctx.from.id);
        payment.verifiedByName = getAdminUsername(ctx);
        await payment.save();

        const inviteLink = await ctx.telegram.createChatInviteLink(process.env.CHANNEL_ID, {
          member_limit: 1,
        });

        const user = await User.findOne({ telegramId: payment.telegramId });
        if (user) {
          user.status = "active";
          await user.save();
        }

        await bot.telegram.sendMessage(
          payment.telegramId,
          "🎉 Payment Approved!\n\n" +
            "Your payment has been successfully verified.\n\n" +
            `💵 Amount: ${payment.amount} ETB\n` +
            `🔖 Reference: ${payment.reference}\n\n` +
            "✅ Your premium access is now active.\n\n" +
            "Click the button below to join the channel.\n\n" +
            "Enjoy the songs! 🎶",
          {
            reply_markup: {
              inline_keyboard: [[{ text: "🎵 Open Premium Channel", url: inviteLink.invite_link }]],
            },
          }
        );

        const approvedCaption =
          "💰 PAYMENT APPROVED\n\n" +
          `🆔 User ID: ${payment.telegramId}\n` +
          `💵 Amount: ${payment.amount} ETB\n` +
          `🔖 Reference: ${payment.reference}\n\n` +
          "✅ Status: Approved\n" +
          `👨‍💼 Approved by: ${payment.verifiedByName}\n` +
          `📅 Verified at: ${payment.verifiedAt.toLocaleString()}`;

        for (const adminMessage of payment.adminMessages || []) {
          try {
            await bot.telegram.editMessageCaption(
              adminMessage.adminId,
              adminMessage.messageId,
              undefined,
              approvedCaption,
              { reply_markup: { inline_keyboard: [] } }
            );
          } catch (error) {
            console.error(`Could not update admin message ${adminMessage.messageId}:`, error.message);
          }
        }
      } catch (error) {
        console.error("Error approving payment:", error);
        await ctx.answerCbQuery("❌ Something went wrong.", { show_alert: true });
      }
    });

    bot.action(/^reject_payment:(.+)$/, async (ctx) => {
      try {
        if (!isAdmin(ctx.from.id)) {
          await ctx.answerCbQuery("❌ You are not authorized.", { show_alert: true });
          return;
        }

        await ctx.answerCbQuery("Processing rejection...");

        const paymentId = ctx.match[1];
        const payment = await Payment.findById(paymentId);

        if (!payment) {
          await ctx.reply("❌ Payment not found.");
          return;
        }

        if (payment.status !== "pending") {
          await ctx.reply(`⚠️ This payment has already been ${payment.status}.`);
          return;
        }

        payment.status = "rejected";
        payment.verifiedAt = new Date();
        payment.verifiedBy = String(ctx.from.id);
        payment.verifiedByName = getAdminUsername(ctx);
        await payment.save();

        await bot.telegram.sendMessage(
          payment.telegramId,
          "❌ Payment Rejected\n\n" +
            "Unfortunately, your payment could not be verified.\n\n" +
            `💵 Amount: ${payment.amount} ETB\n` +
            `🔖 Reference: ${payment.reference}\n\n` +
            "Please check your payment details and try again.",
          {
            reply_markup: {
              inline_keyboard: [[{ text: "🔄 Try Payment Again", callback_data: "retry_payment" }]],
            },
          }
        );

        const rejectedCaption =
          "💰 PAYMENT REJECTED\n\n" +
          `🆔 User ID: ${payment.telegramId}\n` +
          `💵 Amount: ${payment.amount} ETB\n` +
          `🔖 Reference: ${payment.reference}\n\n` +
          "❌ Status: Rejected\n" +
          `👨‍💼 Rejected by: ${payment.verifiedByName}\n` +
          `📅 Reviewed at: ${payment.verifiedAt.toLocaleString()}`;

        for (const adminMessage of payment.adminMessages || []) {
          try {
            await bot.telegram.editMessageCaption(
              adminMessage.adminId,
              adminMessage.messageId,
              undefined,
              rejectedCaption,
              { reply_markup: { inline_keyboard: [] } }
            );
          } catch (error) {
            console.error(`Could not update admin message ${adminMessage.messageId}:`, error.message);
          }
        }
      } catch (error) {
        console.error("Error rejecting payment:", error);
        await ctx.answerCbQuery("❌ Something went wrong.", { show_alert: true });
      }
    });

    bot.action("retry_payment", async (ctx) => {
      await ctx.answerCbQuery();
      await startPayment(ctx);
    });

    bot.action("my_subscription", async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const telegramId = String(ctx.from.id);
        const session = getSession(telegramId);
        const user = await User.findOne({ telegramId });

        let message = "❌ Your account could not be found.\n\nPlease use /start first.";

        if (user) {
          if (user.status === "active") {
            message =
              "🎵 My Subscription\n\n" +
              "Status: ✅ Active\n\n" +
              "Your premium subscription is active.\n\n" +
              "🎶 You have access to our premium church songs channel.";
          } else {
            message =
              "🎵 My Subscription\n\n" +
              "Status: ⏳ Not Active\n\n" +
              "You don't currently have an active subscription.\n\n" +
              "Please subscribe to get access to the premium songs.";
          }
        }

        await deleteLastPrompt(ctx, session);
        const replyMessage = await ctx.reply(message, mainMenu());
        session.lastMessageId = replyMessage.message_id;
      } catch (error) {
        console.error("Error checking subscription:", error);
        await ctx.reply("❌ Something went wrong while checking your subscription.");
      }
    });

    bot.action("how_it_works", async (ctx) => {
      await ctx.answerCbQuery();

      const telegramId = String(ctx.from.id);
      const session = getSession(telegramId);

      await deleteLastPrompt(ctx, session);
      const replyMessage = await ctx.reply(
        "ℹ️ How It Works\n\n" +
          "1️⃣ Choose Subscribe\n\n" +
          "2️⃣ Make the payment using the provided bank account.\n\n" +
          "3️⃣ Submit your payment reference and receipt.\n\n" +
          "4️⃣ We verify your payment.\n\n" +
          "5️⃣ Once approved, you'll receive access to the private channel.\n\n" +
          "🎵 Enjoy the premium church songs!",
        mainMenu()
      );

      session.lastMessageId = replyMessage.message_id;
    });

    await bot.launch();
    console.log("Bot is running");
  } catch (error) {
    console.error("Bot failed to start:", error);
    process.exit(1);
  }
}

startBot();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));