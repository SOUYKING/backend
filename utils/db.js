const mongoose = require("mongoose");

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

const connectDB = async (retryCount = 0) => {
  try {
    if (!process.env.MONGO_URI) {
      console.error("MongoDB URI not set. Set MONGO_URI in environment variables.");
      if (retryCount < MAX_RETRIES) {
        console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        return connectDB(retryCount + 1);
      }
      throw new Error("MONGO_URI is not configured");
    }

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });

    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB error:", error.message);

    if (retryCount < MAX_RETRIES) {
      console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return connectDB(retryCount + 1);
    }

    console.error("MongoDB connection failed after all retries. Server will continue without DB.");
  }
};

module.exports = connectDB;
