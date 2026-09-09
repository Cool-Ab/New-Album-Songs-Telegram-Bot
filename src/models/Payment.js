const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    telegramId: {
      type: String,
      required: true,
    },

    amount: {
      type: Number,
      required: true,
    },

    reference: {
      type: String,
      required: true,
    },

    receiptFileId: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    verifiedBy: {
      type: String,
      default: null,
    },
    verifiedByName: {
        type: String,
        default: null,
    },
    adminMessages: [
        {
            adminId: String,
            messageId: Number,
        },
    ],
  },
  {
    timestamps: true,
  },
  
);

module.exports = mongoose.model("Payment", paymentSchema);