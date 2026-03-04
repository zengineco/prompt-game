const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { loadPrompts } = require('./prompts');

const ROUND_SUBMIT_TIME_MS = 5 * 60 * 1000; // 5 minutes
const VOTE_TIME_MS = 60 * 1000;              // 1 minute to vote
const MAX_PLAYERS = 9;
const MIN_PLAYERS = 3;

class GameManager {
  constructor(client, channel) {
    this.client = client;
    this.channel = channel;
    this.players = [];          // { id, tag, username, score }
    this.dealerIndex = 0;
    this.currentPrompt = null;
    this.submissions = new Map(); // userId -> { text, id }
    this.votes = new Map();       // voterId -> submissionId
    this.round = 0;
    this.phase = 'lobby';        // lobby | responding | voting | resolving
    this.usedPrompts = new Set();
    this.lobbyMessage = null;
    this.roundMessage = null;
    this.submitTimer = null;
    this.voteTimer = null;
    this.allPrompts = loadPrompts();
  }

  // ── Player Management ───────────────────────────────────────────────────────

  addPlayer(user) {
    if (this.phase !== 'lobby') return { message: '❌ A game is already in progress!', ephemeral: true };
    if (this.players.length >= MAX_PLAYERS) return { message: `❌ Table is full! Max ${MAX_PLAYERS} players.`, ephemeral: true };
    if (this.players.find(p => p.id === user.id)) return { message: '✅ You\'re already at the table!', ephemeral: true };

    this.players.push({ id: user.id, tag: user.tag, username: user.username, score: 0 });
    return { message: `✅ **${user.username}** joined the table! (${this.players.length}/${MAX_PLAYERS})`, ephemeral: false, lobbyUpdate: true };
  }

  removePlayer(userId) {
    const idx = this.players.findIndex(p => p.id === userId);
    if (idx === -1) return { message: '❌ You\'re not in the game.', ephemeral: true };
    const name = this.players[idx].username;
    this.players.splice(idx, 1);
    if (this.dealerIndex >= this.players.length) this.dealerIndex = 0;
    return { message: `👋 **${name}** left the table.`, ephemeral: false, lobbyUpdate: true };
  }

  canStart() { return this.players.length >= MIN_PLAYERS; }

  get currentDealer() { return this.players[this.dealerIndex] || null; }

  // ── Lobby ────────────────────────────────────────────────────────────────────

  async updateLobbyMessage() {
    const embed = this.buildLobbyEmbed();
    if (this.lobbyMessage) {
      await this.lobbyMessage.edit({ embeds: [embed] }).catch(() => {});
    } else {
      this.lobbyMessage = await this.channel.send({ embeds: [embed] });
    }
  }

  buildLobbyEmbed() {
    const seats = this.players.map((p, i) => {
      const dealer = i === 0 ? ' 🎙️' : '';
      return `**Seat ${i + 1}:** ${p.username}${dealer}`;
    });
    while (seats.length < MAX_PLAYERS) seats.push(`**Seat ${seats.length + 1}:** *(empty)*`);

    return new EmbedBuilder()
      .setColor('#1a1a2e')
      .setTitle('🃏 PROMPT — The AI Confession Game')
      .setDescription('*You know those questions you ask AI when you think nobody\'s watching?*\n\nEveryone\'s got \'em. Now everyone\'s gonna see \'em.\n\n**How to play:**\n• A PROMPT is revealed — something embarrassingly human\n• Everyone submits what the AI *would* say\n• Vote for the funniest/most fitting response\n• Majority wins. Dealer breaks ties.\n\nUse `/prompt-start` when ready (need 3+ players)')
      .addFields({ name: '🪑 Table', value: seats.join('\n') })
      .setFooter({ text: `${this.players.length}/${MAX_PLAYERS} players • /prompt-join to sit down` });
  }

  // ── Game Flow ─────────────────────────────────────────────────────────────────

  async startGame() {
    this.phase = 'responding';
    this.round = 0;
    if (this.lobbyMessage) await this.lobbyMessage.delete().catch(() => {});
    await this.nextRound();
  }

  async nextRound() {
    this.round++;
    this.submissions.clear();
    this.votes.clear();
    this.phase = 'responding';

    // Pick unused prompt
    const available = this.allPrompts.filter(p => !this.usedPrompts.has(p));
    if (available.length === 0) {
      this.usedPrompts.clear();
      available.push(...this.allPrompts);
    }
    this.currentPrompt = available[Math.floor(Math.random() * available.length)];
    this.usedPrompts.add(this.currentPrompt);

    const dealer = this.currentDealer;
    const nonDealers = this.players.filter(p => p.id !== dealer.id);
    const deadline = new Date(Date.now() + ROUND_SUBMIT_TIME_MS);

    const embed = new EmbedBuilder()
      .setColor('#e94560')
      .setTitle(`🎙️ ROUND ${this.round} — ${dealer.username} is the Dealer`)
      .setDescription(`## "${this.currentPrompt}"`)
      .addFields(
        { name: '⏱️ Submit by', value: `<t:${Math.floor(deadline.getTime() / 1000)}:R>`, inline: true },
        { name: '👥 Responding', value: nonDealers.map(p => `• ${p.username}`).join('\n'), inline: true },
        { name: '📬 Submissions', value: '*(waiting...)*' }
      )
      .setFooter({ text: `Respond like an AI would... the weirder, the better.` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('submit_response')
        .setLabel('💬 Submit My Response')
        .setStyle(ButtonStyle.Primary)
    );

    this.roundMessage = await this.channel.send({ embeds: [embed], components: [row] });

    // Auto-advance after timer
    this.submitTimer = setTimeout(async () => {
      if (this.phase === 'responding') await this.startVoting();
    }, ROUND_SUBMIT_TIME_MS);
  }

  // ── Submissions ───────────────────────────────────────────────────────────────

  hasSubmitted(userId) { return this.submissions.has(userId); }

  submitResponse(userId, text) {
    if (this.phase !== 'responding') return { message: '❌ Submissions are closed!', ephemeral: true };
    const player = this.players.find(p => p.id === userId);
    if (!player) return { message: '❌ You\'re not in this game.', ephemeral: true };

    const subId = `sub_${userId.slice(-4)}_${Date.now().toString(36)}`;
    this.submissions.set(userId, { text, id: subId, username: player.username });

    const nonDealers = this.players.filter(p => p.id !== this.currentDealer?.id);
    const submitted = this.submissions.size;
    const total = nonDealers.length;

    this.updateRoundStatus();
    const allIn = submitted >= total;
    return {
      message: `✅ Response locked in! (${submitted}/${total} submitted)`,
      ephemeral: true,
      allSubmitted: allIn
    };
  }

  async updateRoundStatus() {
    if (!this.roundMessage) return;
    const nonDealers = this.players.filter(p => p.id !== this.currentDealer?.id);
    const submitted = [...nonDealers].map(p => {
      const did = this.submissions.has(p.id);
      return `${did ? '✅' : '⏳'} ${p.username}`;
    }).join('\n');

    try {
      const embed = this.roundMessage.embeds[0];
      const updated = EmbedBuilder.from(embed);
      const fields = updated.data.fields || [];
      const subField = fields.find(f => f.name === '📬 Submissions');
      if (subField) subField.value = submitted || '*(none yet)*';
      await this.roundMessage.edit({ embeds: [updated] });
    } catch (_) {}
  }

  // ── Voting ────────────────────────────────────────────────────────────────────

  async startVoting() {
    if (this.submitTimer) clearTimeout(this.submitTimer);
    this.phase = 'voting';

    if (this.submissions.size === 0) {
      await this.channel.send('😬 Nobody submitted anything. Skipping round...');
      return this.advanceDealer();
    }

    const subs = [...this.submissions.values()];
    // Shuffle for anonymity
    subs.sort(() => Math.random() - 0.5);

    const letters = ['🅰️','🅱️','🇨','🇩','🇪','🇫','🇬','🇭'];
    const responseList = subs.map((s, i) => `${letters[i]} **Response ${i + 1}**\n> ${s.text}`).join('\n\n');

    const dealer = this.currentDealer;
    const deadline = new Date(Date.now() + VOTE_TIME_MS);

    const embed = new EmbedBuilder()
      .setColor('#f5a623')
      .setTitle(`🗳️ VOTE NOW — Round ${this.round}`)
      .setDescription(`**"${this.currentPrompt}"**\n\n${responseList}`)
      .addFields({ name: '⏱️ Voting closes', value: `<t:${Math.floor(deadline.getTime() / 1000)}:R>` })
      .setFooter({ text: `${dealer.username} (Dealer) breaks ties • Vote anonymously — results shown after` });

    const rows = [];
    const buttons = subs.map((s, i) =>
      new ButtonBuilder()
        .setCustomId(`vote_${s.id}`)
        .setLabel(`Response ${i + 1}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(letters[i])
    );

    // Discord max 5 per row
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    if (this.roundMessage) await this.roundMessage.delete().catch(() => {});
    this.roundMessage = await this.channel.send({ embeds: [embed], components: rows });

    // Store shuffled order for reveal
    this.votingOrder = subs;

    this.voteTimer = setTimeout(async () => {
      if (this.phase === 'voting') await this.resolveRound();
    }, VOTE_TIME_MS);
  }

  castVote(voterId, submissionId) {
    if (this.phase !== 'voting') return { message: '❌ Voting is closed.', ephemeral: true };
    const player = this.players.find(p => p.id === voterId);
    if (!player) return { message: '❌ You\'re not in this game.', ephemeral: true };

    // Find who owns this submission
    const ownerEntry = [...this.submissions.entries()].find(([_, s]) => s.id === submissionId);
    if (!ownerEntry) return { message: '❌ Invalid response.', ephemeral: true };
    if (ownerEntry[0] === voterId) return { message: '❌ You can\'t vote for yourself!', ephemeral: true };
    if (this.votes.has(voterId)) return { message: '🔒 Your vote is already locked in!', ephemeral: true };

    this.votes.set(voterId, submissionId);

    const votingPlayers = this.players.filter(p => p.id !== this.currentDealer?.id);
    const allVoted = this.votes.size >= votingPlayers.length - (this.submissions.size < votingPlayers.length ? votingPlayers.length - this.submissions.size : 0);

    return { message: '🔒 Vote locked in!', ephemeral: true, allVoted };
  }

  // ── Round Resolution ──────────────────────────────────────────────────────────

  async resolveRound() {
    if (this.voteTimer) clearTimeout(this.voteTimer);
    this.phase = 'resolving';

    // Tally votes
    const tally = new Map(); // submissionId -> count
    for (const [_, subId] of this.votes) {
      tally.set(subId, (tally.get(subId) || 0) + 1);
    }

    const subs = this.votingOrder || [...this.submissions.values()];
    const results = subs.map(s => ({
      ...s,
      votes: tally.get(s.id) || 0
    })).sort((a, b) => b.votes - a.votes);

    const maxVotes = results[0]?.votes || 0;
    const winners = results.filter(r => r.votes === maxVotes);

    let winnerText = '';
    let winnerId = null;

    if (maxVotes === 0) {
      winnerText = '🤷 No votes cast — Dealer chooses!';
      // Dealer picks first submission as default
    } else if (winners.length === 1) {
      const w = winners[0];
      // Find player
      const [wId] = [...this.submissions.entries()].find(([_, s]) => s.id === w.id) || [];
      if (wId) {
        const player = this.players.find(p => p.id === wId);
        if (player) {
          player.score += 1;
          winnerId = wId;
          winnerText = `🏆 **${player.username}** wins the round! (+1 point)`;
        }
      }
    } else {
      winnerText = `🤝 **TIE!** The Dealer (${this.currentDealer.username}) must choose — ping them!\n*(No points awarded on a tie — Dealer call stands for glory only)*`;
    }

    const breakdown = results.map(r => {
      const [rId] = [...this.submissions.entries()].find(([_, s]) => s.id === r.id) || [];
      const name = rId ? (this.players.find(p => p.id === rId)?.username || 'Unknown') : 'Unknown';
      return `**${name}** (${r.votes} vote${r.votes !== 1 ? 's' : ''})\n> ${r.text}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
      .setColor('#2ecc71')
      .setTitle(`📊 Round ${this.round} Results`)
      .setDescription(`**"${this.currentPrompt}"**\n\n${breakdown}`)
      .addFields({ name: '🎉 Result', value: winnerText })
      .setFooter({ text: 'Next round starting soon...' });

    if (this.roundMessage) await this.roundMessage.edit({ embeds: [embed], components: [] }).catch(() => {});

    await this.channel.send({ embeds: [this.buildScoreboardEmbed()] });

    // Advance dealer and next round after brief pause
    setTimeout(async () => {
      this.advanceDealer();
      await this.nextRound();
    }, 8000);
  }

  advanceDealer() {
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
  }

  // ── Scoreboard ────────────────────────────────────────────────────────────────

  buildScoreboardEmbed() {
    const sorted = [...this.players].sort((a, b) => b.score - a.score);
    const board = sorted.map((p, i) => {
      const medal = ['🥇','🥈','🥉'][i] || `${i + 1}.`;
      const isDealer = p.id === this.currentDealer?.id ? ' 🎙️' : '';
      return `${medal} **${p.username}**${isDealer} — ${p.score} pt${p.score !== 1 ? 's' : ''}`;
    }).join('\n');

    return new EmbedBuilder()
      .setColor('#9b59b6')
      .setTitle(`📋 Scoreboard — Round ${this.round}`)
      .setDescription(board || 'No scores yet.')
      .setFooter({ text: `Round ${this.round} complete` });
  }

  endGame(reason) {
    if (this.submitTimer) clearTimeout(this.submitTimer);
    if (this.voteTimer) clearTimeout(this.voteTimer);
    this.phase = 'ended';
    this.channel.send(`🛑 **Game Over.** ${reason}\n\n${this.buildScoreboardEmbed().data.description}`);
  }
}

module.exports = GameManager;
