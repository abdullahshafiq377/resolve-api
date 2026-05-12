const mongoose = require('mongoose');
const dns = require('dns');

// Force Node.js c-ares to use Google DNS — avoids Windows resolver issues with SRV lookups
dns.setServers(['8.8.8.8', '1.1.1.1']);

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not defined in environment');

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(uri);
      console.log(`MongoDB connected (attempt ${attempt})`);
      return mongoose.connection;
    } catch (err) {
      lastError = err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.error(`MongoDB connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(`MongoDB failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

async function closeDB() {
  await mongoose.connection.close();
  console.log('MongoDB connection closed');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { connectDB, closeDB };
