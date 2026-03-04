// deploy-commands.js — Run this once to register slash commands with Discord
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('prompt-join')
    .setDescription('🪑 Sit down at the PROMPT table'),

  new SlashCommandBuilder()
    .setName('prompt-leave')
    .setDescription('🚪 Leave the current game lobby'),

  new SlashCommandBuilder()
    .setName('prompt-start')
    .setDescription('🚀 Start the game (need 3–9 players)'),

  new SlashCommandBuilder()
    .setName('prompt-end')
    .setDescription('🛑 End the current game (mod only)')
    .setDefaultMemberPermissions('0'),

  new SlashCommandBuilder()
    .setName('prompt-scores')
    .setDescription('📋 Show the current scoreboard'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('📡 Registering slash commands...');

    // Guild-specific (instant, for dev):
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Commands registered to guild ${process.env.GUILD_ID}`);
    } else {
      // Global (takes up to 1hr to propagate):
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Commands registered globally');
    }
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
    process.exit(1);
  }
})();
