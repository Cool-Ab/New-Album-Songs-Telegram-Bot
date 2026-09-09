require("dotenv").config();

const { Telegraf } = require("telegraf");
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

  // Special case: Admin 3 should be displayed as the configured name
  if (id === String(process.env.ADMIN_TELEGRAM_ID_3)) {
    return process.env.ADMIN_3_SHOW_AS;
  }

  // Admin 1 and Admin 2 use their actual Telegram username
  if (ctx.from.username) {
    return `@${ctx.from.username}`;
  }

  // Fallback if they don't have a Telegram username
  return `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
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

          console.log(`Received /start from ${telegramId}`);

          // Check if the user already exists
          let user = await User.findOne({ telegramId });

          if (!user) {
            // Create new user
            user = await User.create({
              telegramId,
              username: ctx.from.username || null,
              firstName: ctx.from.first_name || null,
              lastName: ctx.from.last_name || null,
              status: "pending",
            });

            console.log(`New user created: ${telegramId}`);
          } else {
            // Update user's Telegram information
            user.username = ctx.from.username || null;
            user.firstName = ctx.from.first_name || null;
            user.lastName = ctx.from.last_name || null;

            await user.save();

            console.log(`Existing user updated: ${telegramId}`);
          }

          await ctx.reply(
            "🎵 Welcome to Premium Church Songs!\n\n" +
            "Enjoy access to our premium collection of church songs.\n\n" +
            "Subscription Status: ⏳ Not Active\n\n" +
            "What would you like to do?",
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "💳 Subscribe",
                      callback_data: "subscribe",
                    },
                  ],
                  [
                    {
                      text: "🎵 My Subscription",
                      callback_data: "my_subscription",
                    },
                    {
                      text: "ℹ️ How It Works",
                      callback_data: "how_it_works",
                    },
                  ],
                ],
              },
            }
          );
        } catch (error) {
          console.error("Error processing /start:", error);

          await ctx.reply(
            "❌ Something went wrong while creating your account.\n\n" +
            "Please try again later."
          );
        }
      });
async function startPayment(ctx) {
  const telegramId = String(ctx.from.id);

  paymentSessions.set(telegramId, {
    step: "waiting_for_reference",
  });

  await ctx.reply(
    "💳 Subscription\n\n" +
      `Monthly subscription: ${process.env.SUBSCRIPTION_PRICE} ETB\n\n` +
      "Please make your payment using the following account:\n\n" +
      `🏦 Bank: ${process.env.BANK_NAME}\n` +
      `👤 Account Name: ${process.env.ACCOUNT_NAME}\n` +
      `🔢 Account Number: ${process.env.ACCOUNT_NUMBER}\n\n` +
      "After making the payment, send your payment reference number here."
  );
}
bot.action("subscribe", async (ctx) => {
  await ctx.answerCbQuery();

  await startPayment(ctx);
});

        bot.on("photo", async (ctx) => {
          try {
            const telegramId = String(ctx.from.id);

            console.log(`Receipt received from ${telegramId}`);

            const session = paymentSessions.get(telegramId);

            // User isn't currently making a payment
            if (!session) {
              await ctx.reply(
                "ℹ️ You don't currently have a payment process in progress.\n\n" +
                "Please click 💳 Subscribe to start a payment."
              );

              return;
            }

            // User sent photo before reference
            if (session.step === "waiting_for_reference") {
              await ctx.reply(
                "❌ Please send your payment reference number first.\n\n" +
                "After you send the reference number, I'll ask you for your payment receipt."
              );

              return;
            }

            // We are expecting the receipt
            if (session.step !== "waiting_for_receipt") {
              await ctx.reply(
                "❌ Something went wrong with your payment session.\n\n" +
                "Please start the subscription process again."
              );

              paymentSessions.delete(telegramId);

              return;
            }

            // --------------------------------
            // Receipt processing starts here
            // --------------------------------

            const photos = ctx.message.photo;
            const largestPhoto = photos[photos.length - 1];

            console.log("Creating payment in MongoDB...");

            const payment = await Payment.create({
              telegramId,
              amount: Number(process.env.SUBSCRIPTION_PRICE),
              reference: session.reference,
              receiptFileId: largestPhoto.file_id,
              status: "pending",
            });

            console.log(`Payment submitted: ${payment._id}`);

            // Send payment notification to admin
            console.log("Sending payment notification to admin...");

            const adminIds = [
              process.env.ADMIN_TELEGRAM_ID_1,
              process.env.ADMIN_TELEGRAM_ID_2,
              process.env.ADMIN_TELEGRAM_ID_3,
            ];

            const adminMessages = [];

            for (const adminId of adminIds) {
              const adminMessage = await bot.telegram.sendPhoto(
                adminId,
                largestPhoto.file_id,
                {
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
                        {
                          text: "✅ Approve",
                          callback_data: `approve_payment:${payment._id}`,
                        },
                        {
                          text: "❌ Reject",
                          callback_data: `reject_payment:${payment._id}`,
                        },
                      ],
                    ],
                  },
                }
              );

              adminMessages.push({
                adminId: String(adminId),
                messageId: adminMessage.message_id,
              });
            }

            payment.adminMessages = adminMessages;

            await payment.save();

            console.log("Payment notification sent to admin.");

            // Clear payment session
            paymentSessions.delete(telegramId);

            await ctx.reply(
              "✅ Payment submitted successfully!\n\n" +
                `🔖 Reference: ${payment.reference}\n` +
                `💵 Amount: ${payment.amount} ETB\n\n` +
                "⏳ Your payment is now waiting for verification.\n\n" +
                "You will receive a notification once it has been reviewed."
            );

          } catch (error) {
            console.error("Error processing receipt:", error);

            await ctx.reply(
              "❌ We couldn't submit your payment.\n\n" +
              "Please try again."
            );
          }
        });

      //approve button
bot.action(/^approve_payment:(.+)$/, async (ctx) => {
  try {
    // Security check
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("❌ You are not authorized.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery("Processing approval...");

    const paymentId = ctx.match[1];

    console.log(`Admin approving payment: ${paymentId}`);

    const payment = await Payment.findById(paymentId);

    if (!payment) {
      await ctx.reply("❌ Payment not found.");
      return;
    }

    if (payment.status !== "pending") {
      await ctx.reply(
        `⚠️ This payment has already been ${payment.status}.`
      );
      return;
    }

    // Store the actual admin who clicked
    payment.status = "approved";
    payment.verifiedAt = new Date();
    payment.verifiedBy = String(ctx.from.id);

    // Get the username to display
const approvedByUsername = getAdminUsername(ctx);

payment.verifiedByName = approvedByUsername;
    await payment.save();

    // Create one-time channel invite
    const inviteLink = await ctx.telegram.createChatInviteLink(
      process.env.CHANNEL_ID,
      {
        member_limit: 1,
      }
    );

    console.log(`Payment approved: ${paymentId}`);

    // Update user status
    const user = await User.findOne({
      telegramId: payment.telegramId,
    });

    if (user) {
      user.status = "active";
      await user.save();

      console.log(
        `User ${payment.telegramId} status changed to active`
      );
    }

    // Notify the user
    await bot.telegram.sendMessage(
      payment.telegramId,
      "🎉 Payment Approved!\n\n" +
        "Your payment has been successfully verified.\n\n" +
        `💵 Amount: ${payment.amount} ETB\n` +
        `🔖 Reference: ${payment.reference}\n\n` +
        "✅ Your premium access is now active.\n\n" +
        "🎵 Your access to the private premium church songs channel is ready!\n\n" +
        "Click the button below to join the channel.\n\n" +
        "Enjoy the songs! 🎶",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎵 Open Premium Channel",
                url: inviteLink.invite_link,
              },
            ],
          ],
        },
      }
    );

    // Update ALL admin messages
    const approvedCaption =
      "💰 PAYMENT APPROVED\n\n" +
      `🆔 User ID: ${payment.telegramId}\n` +
      `💵 Amount: ${payment.amount} ETB\n` +
      `🔖 Reference: ${payment.reference}\n\n` +
      "✅ Status: Approved\n" +
      `👨‍💼 Approved by: ${approvedByUsername}\n` +
      `📅 Verified at: ${payment.verifiedAt.toLocaleString()}`;

    for (const adminMessage of payment.adminMessages) {
      try {
        await bot.telegram.editMessageCaption(
          adminMessage.adminId,
          adminMessage.messageId,
          undefined,
          approvedCaption,
          {
            reply_markup: {
              inline_keyboard: [],
            },
          }
        );
      } catch (error) {
        console.error(
          `Could not update admin message ${adminMessage.messageId}:`,
          error.message
        );
      }
    }

    console.log("All admin notifications updated.");
  } catch (error) {
    console.error("Error approving payment:", error);

    await ctx.answerCbQuery(
      "❌ Something went wrong.",
      { show_alert: true }
    );
  }
});

      //reject button
bot.action(/^reject_payment:(.+)$/, async (ctx) => {
  try {
    // Security check
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery("❌ You are not authorized.", {
        show_alert: true,
      });
      return;
    }

    await ctx.answerCbQuery("Processing rejection...");

    const paymentId = ctx.match[1];

    console.log(`Admin rejecting payment: ${paymentId}`);

    const payment = await Payment.findById(paymentId);

    if (!payment) {
      await ctx.reply("❌ Payment not found.");
      return;
    }

    if (payment.status !== "pending") {
      await ctx.reply(
        `⚠️ This payment has already been ${payment.status}.`
      );
      return;
    }

    // Store the actual admin who clicked
    payment.status = "rejected";
    payment.verifiedAt = new Date();
    payment.verifiedBy = String(ctx.from.id);

    // Get the username to display
const rejectedByUsername = getAdminUsername(ctx);

payment.verifiedByName = rejectedByUsername;

    await payment.save();

    console.log(`Payment rejected: ${paymentId}`);

    // Notify the user
    await bot.telegram.sendMessage(
      payment.telegramId,
      "❌ Payment Rejected\n\n" +
        "Unfortunately, your payment could not be verified.\n\n" +
        `💵 Amount: ${payment.amount} ETB\n` +
        `🔖 Reference: ${payment.reference}\n\n` +
        "Please check your payment details and try again.\n\n" +
        "You can start a new payment below.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 Try Payment Again",
                callback_data: "retry_payment",
              },
            ],
          ],
        },
      }
    );

    // Update ALL admin messages
    const rejectedCaption =
      "💰 PAYMENT REJECTED\n\n" +
      `🆔 User ID: ${payment.telegramId}\n` +
      `💵 Amount: ${payment.amount} ETB\n` +
      `🔖 Reference: ${payment.reference}\n\n` +
      "❌ Status: Rejected\n" +
      `👨‍💼 Rejected by: ${rejectedByUsername}\n` +
      `📅 Reviewed at: ${payment.verifiedAt.toLocaleString()}`;

    for (const adminMessage of payment.adminMessages) {
      try {
        await bot.telegram.editMessageCaption(
          adminMessage.adminId,
          adminMessage.messageId,
          undefined,
          rejectedCaption,
          {
            reply_markup: {
              inline_keyboard: [],
            },
          }
        );
      } catch (error) {
        console.error(
          `Could not update admin message ${adminMessage.messageId}:`,
          error.message
        );
      }
    }

    console.log("All admin notifications updated.");
  } catch (error) {
    console.error("Error rejecting payment:", error);

    await ctx.answerCbQuery(
      "❌ Something went wrong.",
      { show_alert: true }
    );
  }
});

bot.action("retry_payment", async (ctx) => {
  await ctx.answerCbQuery();

  await startPayment(ctx);
});

          //chatting texts
        bot.on("text", async (ctx) => {
          try {
            const telegramId = String(ctx.from.id);
            const session = paymentSessions.get(telegramId);

            // User is not currently making a payment
            if (!session) {
              return;
            }

            // -------------------------------
            // STEP 1: Waiting for reference
            // -------------------------------

            if (session.step === "waiting_for_reference") {
              const reference = ctx.message.text.trim();

              if (!reference || reference.length < 3) {
                await ctx.reply(
                  "❌ That doesn't look like a valid payment reference.\n\n" +
                  "Please send the payment reference number you received after making your payment."
                );

                return;
              }

              paymentSessions.set(telegramId, {
                step: "waiting_for_receipt",
                reference,
              });

              await ctx.reply(
                "✅ Payment reference received.\n\n" +
                `🔖 Reference: ${reference}\n\n` +
                "Now please send your payment receipt/screenshot here.\n\n" +
                "📸 Send it as an image."
              );

              return;
            }

            // -------------------------------
            // STEP 2: Waiting for receipt
            // -------------------------------

            if (session.step === "waiting_for_receipt") {
              await ctx.reply(
                "📸 Please send your payment receipt as an image.\n\n" +
                `🔖 Your reference: ${session.reference}`
              );

              return;
            }

          } catch (error) {
            console.error("Error processing payment message:", error);

            await ctx.reply(
              "❌ Something went wrong.\n\n" +
              "Please try again."
            );
          }
        });

        bot.action("my_subscription", async (ctx) => {
          await ctx.answerCbQuery();

          try {
            const telegramId = String(ctx.from.id);

            const user = await User.findOne({
              telegramId,
            });

            if (!user) {
              await ctx.reply(
                "❌ Your account could not be found.\n\nPlease use /start first."
              );
              return;
            }

            if (user.status === "active") {
              await ctx.reply(
                "🎵 My Subscription\n\n" +
                "Status: ✅ Active\n\n" +
                "Your premium subscription is active.\n\n" +
                "🎶 You have access to our premium church songs channel."
              );
            } else {
              await ctx.reply(
                "🎵 My Subscription\n\n" +
                "Status: ⏳ Not Active\n\n" +
                "You don't currently have an active subscription.\n\n" +
                "Please subscribe to get access to the premium songs."
              );
            }
          } catch (error) {
            console.error("Error checking subscription:", error);

            await ctx.reply(
              "❌ Something went wrong while checking your subscription."
            );
          }
        });

      bot.action("how_it_works", async (ctx) => {
        await ctx.answerCbQuery();

        await ctx.reply(
          "ℹ️ How It Works\n\n" +
          "1️⃣ Choose Subscribe\n\n" +
          "2️⃣ Make the payment using the provided bank account.\n\n" +
          "3️⃣ Submit your payment reference and receipt.\n\n" +
          "4️⃣ We verify your payment.\n\n" +
          "5️⃣ Once approved, you'll receive access to the private channel.\n\n" +
          "🎵 Enjoy the premium church songs!"
        );
      });
    console.log("Starting polling...");

    let offset = 0;

        while (true) {
          try {
            const updates = await bot.telegram.callApi("getUpdates", {
              offset,
              limit: 100,
              timeout: 30,
            });

            for (const update of updates) {
              offset = update.update_id + 1;

              console.log(
                `Processing update ${update.update_id}, next offset: ${offset}`
              );

              await bot.handleUpdate(update);
            }
          } catch (error) {
            console.error("Polling connection error:", error.message);

            console.log("Retrying polling in 5 seconds...");

            await new Promise((resolve) =>
              setTimeout(resolve, 5000)
            );
          }
        }

  } catch (error) {
    console.error("Bot failed to start:");
    console.error(error);
  }
}

startBot();