// index.js — Entry point for PROMPT Discord Bot
require('dotenv').config();
const { client } = require('./src/bot');

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set in .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to log in:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
