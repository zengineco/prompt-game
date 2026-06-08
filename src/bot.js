// ============================================================
// PROMPT (Reverse Mode) v2.0.0 — Bot / Interaction Router
// Discord client, slash-command + button + modal routing
// Zengine™ | www.zengine.site
// ============================================================
//
// WORKFLOW STACK:
// 1. Boot Discord client with required intents
// 2. Route slash commands: /prompt-join, /prompt-leave, /prompt-start, /prompt-end, /prompt-scores
// 3. Route buttons: submit_response (open prompt modal), vote_* (cast a vote)
// 4. Route modal: response_modal (the player's reverse-engineered prompt)
// 5. One GameManager per guild, kept in the games Map
//
// ASSET MANIFEST:
// - discord.js (Client, Gateway intents, builders, modal/text-input)
// - ./gameManager (GameManager class)
// - ./responses (loadResponses) — used only for the boot deck-count log
//
// BOOT ORDER:
// - index.js requires this file, then calls client.login()
// - 'ready' fires → log deck size
//
// NOTE: custom IDs (submit_response / response_modal / response_text / vote_*) are kept from v1
//       so nothing downstream needs re-wiring. Only the player-facing copy changed.
// ============================================================

var { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } = require('discord.js');
var GameManager = require('./gameManager');
var { loadResponses } = require('./responses');

var client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ]
});

var games = new Map(); // guildId -> GameManager

client.once('ready', function () {
  console.log(`🤖 PROMPT Bot is online as ${client.user.tag}`);
  console.log(`📦 Loaded ${loadResponses().length} responses`);
});

client.on('interactionCreate', async function (interaction) {
  var guildId = interaction.guildId;

  try {
    // ── Slash Commands ────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      var commandName = interaction.commandName;

      if (commandName === 'prompt-join') {
        if (!games.has(guildId)) {
          games.set(guildId, new GameManager(client, interaction.channel));
        }
        var joinGame = games.get(guildId);
        var joinResult = joinGame.addPlayer(interaction.user);
        await interaction.reply({ content: joinResult.message, ephemeral: joinResult.ephemeral });
        if (joinResult.lobbyUpdate) await joinGame.updateLobbyMessage();
      }

      else if (commandName === 'prompt-leave') {
        var leaveGame = games.get(guildId);
        if (!leaveGame) return interaction.reply({ content: '❌ No game in progress.', ephemeral: true });
        var leaveResult = leaveGame.removePlayer(interaction.user.id);
        await interaction.reply({ content: leaveResult.message, ephemeral: true });
        if (leaveResult.lobbyUpdate) await leaveGame.updateLobbyMessage();
      }

      else if (commandName === 'prompt-start') {
        var startGame = games.get(guildId);
        if (!startGame) return interaction.reply({ content: '❌ No lobby found. Use `/prompt-join` first!', ephemeral: true });
        if (!startGame.canStart()) return interaction.reply({ content: `❌ Need at least 3 players to start. Currently: ${startGame.players.length}`, ephemeral: true });
        var chosenDeck = interaction.options.getString('category'); // null = mixed deck
        var deckLabel = startGame.setDeck(chosenDeck);
        await interaction.deferReply();
        await startGame.startGame();
        await interaction.deleteReply();
        await interaction.followUp({ content: `🃏 Deck: **${deckLabel}**`, ephemeral: false });
      }

      else if (commandName === 'prompt-end') {
        var endGame = games.get(guildId);
        if (!endGame) return interaction.reply({ content: '❌ No game in progress.', ephemeral: true });
        endGame.endGame('Game ended by moderator.');
        games.delete(guildId);
        await interaction.reply('🛑 Game ended.');
      }

      else if (commandName === 'prompt-scores') {
        var scoreGame = games.get(guildId);
        if (!scoreGame) return interaction.reply({ content: '❌ No game in progress.', ephemeral: true });
        await interaction.reply({ embeds: [scoreGame.buildScoreboardEmbed()], ephemeral: false });
      }
    }

    // ── Button Interactions ───────────────────────────────────────────────────
    if (interaction.isButton()) {
      var btnGame = games.get(guildId);
      if (!btnGame) return interaction.reply({ content: '❌ No active game.', ephemeral: true });

      if (interaction.customId === 'submit_response') {
        if (!btnGame.players.find(function (p) { return p.id === interaction.user.id; })) {
          return interaction.reply({ content: '❌ You\'re not in this game!', ephemeral: true });
        }
        if (btnGame.hasSubmitted(interaction.user.id)) {
          return interaction.reply({ content: '✅ You already submitted a prompt this round!', ephemeral: true });
        }

        var modal = new ModalBuilder()
          .setCustomId('response_modal')
          .setTitle('🔍 Your Reverse Prompt');

        var promptInput = new TextInputBuilder()
          .setCustomId('response_text')
          .setLabel('What did someone ask to get that answer?')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Write the question you think broke the AI...')
          .setRequired(true)
          .setMaxLength(300);

        modal.addComponents(new ActionRowBuilder().addComponents(promptInput));
        await interaction.showModal(modal);
      }

      if (interaction.customId.startsWith('vote_')) {
        var submissionId = interaction.customId.replace('vote_', '');
        var voteResult = btnGame.castVote(interaction.user.id, submissionId);
        await interaction.reply({ content: voteResult.message, ephemeral: true });
        if (voteResult.allVoted) await btnGame.resolveRound();
      }
    }

    // ── Modal Submissions ─────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'response_modal') {
        var modalGame = games.get(guildId);
        if (!modalGame) return interaction.reply({ content: '❌ No active game.', ephemeral: true });

        var text = interaction.fields.getTextInputValue('response_text');
        var submitResult = modalGame.submitResponse(interaction.user.id, text);
        await interaction.reply({ content: submitResult.message, ephemeral: true });
        if (submitResult.allSubmitted) await modalGame.startVoting();
      }
    }
  } catch (err) {
    console.error('interactionCreate:', err);
  }
});

module.exports = { client, games };
