const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
const GameManager = require('./gameManager');
const { loadPrompts } = require('./prompts');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ]
});

const games = new Map(); // guildId -> GameManager

client.once('ready', () => {
  console.log(`🤖 PROMPT Bot is online as ${client.user.tag}`);
  console.log(`📦 Loaded ${loadPrompts().length} prompts`);
});

client.on('interactionCreate', async (interaction) => {
  const guildId = interaction.guildId;

  // ── Slash Commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'prompt-join') {
      if (!games.has(guildId)) {
        const game = new GameManager(client, interaction.channel);
        games.set(guildId, game);
      }
      const game = games.get(guildId);
      const result = game.addPlayer(interaction.user);
      await interaction.reply({ content: result.message, ephemeral: result.ephemeral });
      if (result.lobbyUpdate) await game.updateLobbyMessage();
    }

    else if (commandName === 'prompt-leave') {
      const game = games.get(guildId);
      if (!game) return interaction.reply({ content: '❌ No game in progress.', ephemeral: true });
      const result = game.removePlayer(interaction.user.id);
      await interaction.reply({ content: result.message, ephemeral: true });
      if (result.lobbyUpdate) await game.updateLobbyMessage();
    }

    else if (commandName === 'prompt-start') {
      const game = games.get(guildId);
      if (!game) return interaction.reply({ content: '❌ No lobby found. Use `/prompt-join` first!', ephemeral: true });
      if (!game.canStart()) return interaction.reply({ content: `❌ Need at least 3 players to start. Currently: ${game.players.length}`, ephemeral: true });
      await interaction.deferReply();
      await game.startGame();
      await interaction.deleteReply();
    }

    else if (commandName === 'prompt-end') {
      const game = games.get(guildId);
      if (!game) return interaction.reply({ content: '❌ No game in progress.', ephemeral: true });
      game.endGame('Game ended by moderator.');
      games.delete(guildId);
      await interaction.reply('🛑 Game ended.');
    }

    else if (commandName === 'prompt-scores') {
      const game = games.get(guildId);
      if (!game) return interaction.reply({ content: '❌ No game in progress.', ephemeral: true });
      await interaction.reply({ embeds: [game.buildScoreboardEmbed()], ephemeral: false });
    }
  }

  // ── Button Interactions ─────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const game = games.get(guildId);
    if (!game) return interaction.reply({ content: '❌ No active game.', ephemeral: true });

    if (interaction.customId === 'submit_response') {
      if (!game.players.find(p => p.id === interaction.user.id)) {
        return interaction.reply({ content: '❌ You\'re not in this game!', ephemeral: true });
      }
      if (game.hasSubmitted(interaction.user.id)) {
        return interaction.reply({ content: '✅ You already submitted a response this round!', ephemeral: true });
      }
      if (game.currentDealer?.id === interaction.user.id) {
        return interaction.reply({ content: '🎙️ You\'re the Dealer this round — you don\'t respond, you judge!', ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId('response_modal')
        .setTitle('💬 Your AI Response');

      const responseInput = new TextInputBuilder()
        .setCustomId('response_text')
        .setLabel('Respond to the prompt like an AI would...')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Be weird, be smart, be disturbingly helpful...')
        .setRequired(true)
        .setMaxLength(300);

      modal.addComponents(new ActionRowBuilder().addComponents(responseInput));
      await interaction.showModal(modal);
    }

    if (interaction.customId.startsWith('vote_')) {
      const submissionId = interaction.customId.replace('vote_', '');
      const result = game.castVote(interaction.user.id, submissionId);
      await interaction.reply({ content: result.message, ephemeral: true });
      if (result.allVoted) await game.resolveRound();
    }
  }

  // ── Modal Submissions ───────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'response_modal') {
      const game = games.get(guildId);
      if (!game) return interaction.reply({ content: '❌ No active game.', ephemeral: true });

      const text = interaction.fields.getTextInputValue('response_text');
      const result = game.submitResponse(interaction.user.id, text);
      await interaction.reply({ content: result.message, ephemeral: true });
      if (result.allSubmitted) await game.startVoting();
    }
  }
});

module.exports = { client, games };
