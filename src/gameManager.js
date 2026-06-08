// ============================================================
// PROMPT (Reverse Mode) v2.0.0
// Discord party game — recover the question that broke the AI
// Zengine™ | www.zengine.site
// ============================================================
//
// WORKFLOW STACK:
// 1. Players join the lobby (/prompt-join). EVERY player plays every round — no dealer, no sit-out.
// 2. /prompt-start → nextRound() reveals one AI RESPONSE from the deck.
// 3. Each player submits the PROMPT (the question) they think caused that response.
// 4. startVoting() shuffles the submitted prompts and players vote anonymously (no self-vote).
// 5. resolveRound() tallies votes, awards points to the winning prompt(s), posts the scoreboard, loops.
//
// ASSET MANIFEST:
// - discord.js (EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle)
// - ./responses (loadResponses) — the AI-answer deck players reverse-engineer
//
// BOOT ORDER:
// - Instantiated per-guild by bot.js: new GameManager(client, channel)
// - allResponses loaded once in the constructor
//
// DEALER REMOVAL NOTE:
// - v1 had a rotating Dealer who sat out each round (dealerIndex / currentDealer / advanceDealer).
//   That mechanic is fully deleted here. With 3 players, all 3 now write a prompt every round.
// ============================================================

var { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
var { loadResponses } = require('./responses');

var ROUND_SUBMIT_TIME_MS = 5 * 60 * 1000; // 5 minutes to write your prompt
var VOTE_TIME_MS = 60 * 1000;             // 1 minute to vote
var MAX_PLAYERS = 9;
var MIN_PLAYERS = 3;

// Pretty labels for the response decks (keys must match DECKS in responses.js)
var CATEGORY_LABELS = {
  all: 'Mixed Deck',
  legal: 'Legal',
  hr: 'HR',
  incident: 'Incident',
  existential: 'Existential',
  aipanic: 'AI Panic',
  doom: 'Doom',
  unhinged: 'Unhinged',
  relatable: 'Relatable'
};

class GameManager {
  constructor(client, channel) {
    // STATE — all mutable per-guild game state lives on this instance
    this.client = client;
    this.channel = channel;
    this.players = [];            // { id, tag, username, score }
    this.currentResponse = null;  // the AI answer revealed this round
    this.submissions = new Map(); // userId -> { text, id, username }  (each player's guessed prompt)
    this.votes = new Map();       // voterId -> submissionId
    this.round = 0;
    this.phase = 'lobby';         // lobby | responding | voting | resolving | ended
    this.usedResponses = new Set();
    this.lobbyMessage = null;
    this.roundMessage = null;
    this.submitTimer = null;
    this.voteTimer = null;
    this.votingOrder = null;
    this.category = 'all';
    this.allResponses = loadResponses();
  }

  // ── Deck Selection ──────────────────────────────────────────────────────────

  // WRITES: this.category, this.allResponses, this.usedResponses
  // Called at /prompt-start; falls back to the mixed deck for an unknown key.
  setDeck(category) {
    this.category = (category && CATEGORY_LABELS[category]) ? category : 'all';
    this.allResponses = loadResponses(this.category);
    this.usedResponses.clear();
    return this.deckLabel();
  }

  // READS: this.category
  deckLabel() {
    return CATEGORY_LABELS[this.category] || CATEGORY_LABELS.all;
  }

  // ── Player Management ───────────────────────────────────────────────────────

  // WRITES: this.players
  addPlayer(user) {
    if (this.phase !== 'lobby') return { message: '❌ A game is already in progress!', ephemeral: true };
    if (this.players.length >= MAX_PLAYERS) return { message: `❌ Table is full! Max ${MAX_PLAYERS} players.`, ephemeral: true };
    if (this.players.find(function (p) { return p.id === user.id; })) {
      return { message: '✅ You\'re already at the table!', ephemeral: true };
    }
    this.players.push({ id: user.id, tag: user.tag, username: user.username, score: 0 });
    return { message: `✅ **${user.username}** sat down! (${this.players.length}/${MAX_PLAYERS})`, ephemeral: false, lobbyUpdate: true };
  }

  // WRITES: this.players
  removePlayer(userId) {
    var idx = this.players.findIndex(function (p) { return p.id === userId; });
    if (idx === -1) return { message: '❌ You\'re not in the game.', ephemeral: true };
    var name = this.players[idx].username;
    this.players.splice(idx, 1);
    return { message: `👋 **${name}** left the table.`, ephemeral: false, lobbyUpdate: true };
  }

  // READS: this.players
  canStart() { return this.players.length >= MIN_PLAYERS; }

  // ── Lobby ────────────────────────────────────────────────────────────────────

  // READS: this.lobbyMessage  WRITES: this.lobbyMessage
  async updateLobbyMessage() {
    try {
      var embed = this.buildLobbyEmbed();
      if (this.lobbyMessage) {
        await this.lobbyMessage.edit({ embeds: [embed] });
      } else {
        this.lobbyMessage = await this.channel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error('updateLobbyMessage:', err);
    }
  }

  // READS: this.players
  buildLobbyEmbed() {
    var seats = this.players.map(function (p, i) {
      return `**Seat ${i + 1}:** ${p.username}`;
    });
    while (seats.length < MAX_PLAYERS) seats.push(`**Seat ${seats.length + 1}:** *(empty)*`);

    return new EmbedBuilder()
      .setColor('#00ff66')
      .setTitle('🖥️ PROMPT — Reverse Mode')
      .setDescription(
        '*An AI gave a very specific answer. Your job: figure out what someone asked to get it.*\n\n' +
        '**How to play:**\n' +
        '• A recovered AI **response** appears\n' +
        '• **Everyone** secretly writes the **prompt** that could have caused it\n' +
        '• All guesses are revealed and voted on (no self-votes)\n' +
        '• Funniest / most-fitting reconstruction wins the point\n\n' +
        'No dealer. No sitting out. Everyone plays every round.\n' +
        'Use `/prompt-start` when ready (need 3+ players).'
      )
      .addFields({ name: '🪑 Table', value: seats.join('\n') })
      .setFooter({ text: `${this.players.length}/${MAX_PLAYERS} players • /prompt-join to sit down` });
  }

  // ── Game Flow ─────────────────────────────────────────────────────────────────

  // WRITES: this.phase, this.round, this.lobbyMessage
  async startGame() {
    this.phase = 'responding';
    this.round = 0;
    if (this.lobbyMessage) {
      try { await this.lobbyMessage.delete(); } catch (err) { console.error('startGame deleteLobby:', err); }
    }
    await this.nextRound();
  }

  // WRITES: this.round, this.submissions, this.votes, this.phase, this.currentResponse,
  //         this.usedResponses, this.roundMessage, this.submitTimer
  async nextRound() {
    var self = this;
    this.round++;
    this.submissions.clear();
    this.votes.clear();
    this.phase = 'responding';

    // Pick an unused response; reshuffle the deck once exhausted
    var available = this.allResponses.filter(function (r) { return !self.usedResponses.has(r); });
    if (available.length === 0) {
      this.usedResponses.clear();
      available = this.allResponses.slice();
    }
    this.currentResponse = available[Math.floor(Math.random() * available.length)];
    this.usedResponses.add(this.currentResponse);

    var deadline = new Date(Date.now() + ROUND_SUBMIT_TIME_MS);
    var playerList = this.players.map(function (p) { return `• ${p.username}`; }).join('\n');

    var embed = new EmbedBuilder()
      .setColor('#00ff66')
      .setTitle(`🖥️ ROUND ${this.round} — Recover the Prompt`)
      .setDescription(`The AI said:\n\n## "${this.currentResponse}"\n\n*What did someone ask to get this answer? Submit your prompt.*`)
      .addFields(
        { name: '⏱️ Submit by', value: `<t:${Math.floor(deadline.getTime() / 1000)}:R>`, inline: true },
        { name: '🕵️ Players', value: playerList, inline: true },
        { name: '📬 Submissions', value: '*(waiting...)*' }
      )
      .setFooter({ text: `Deck: ${this.deckLabel()} • Reverse-engineer the question. The more believable-yet-cursed, the better.` });

    var row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('submit_response')
        .setLabel('🔍 Submit My Prompt')
        .setStyle(ButtonStyle.Primary)
    );

    try {
      this.roundMessage = await this.channel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error('nextRound send:', err);
    }

    // Auto-advance to voting when the timer expires
    this.submitTimer = setTimeout(function () {
      if (self.phase === 'responding') {
        self.startVoting().catch(function (err) { console.error('submitTimer startVoting:', err); });
      }
    }, ROUND_SUBMIT_TIME_MS);
  }

  // ── Submissions ───────────────────────────────────────────────────────────────

  // READS: this.submissions
  hasSubmitted(userId) { return this.submissions.has(userId); }

  // WRITES: this.submissions
  submitResponse(userId, text) {
    if (this.phase !== 'responding') return { message: '❌ Submissions are closed!', ephemeral: true };
    var player = this.players.find(function (p) { return p.id === userId; });
    if (!player) return { message: '❌ You\'re not in this game.', ephemeral: true };

    var subId = `sub_${userId.slice(-4)}_${Date.now().toString(36)}`;
    this.submissions.set(userId, { text: text, id: subId, username: player.username });

    var submitted = this.submissions.size;
    var total = this.players.length; // everyone plays — no dealer exclusion

    this.updateRoundStatus();
    return {
      message: `✅ Prompt locked in! (${submitted}/${total} submitted)`,
      ephemeral: true,
      allSubmitted: submitted >= total
    };
  }

  // READS: this.roundMessage, this.players, this.submissions  WRITES: this.roundMessage embed
  async updateRoundStatus() {
    if (!this.roundMessage) return;
    var self = this;
    var lines = this.players.map(function (p) {
      var did = self.submissions.has(p.id);
      return `${did ? '✅' : '⏳'} ${p.username}`;
    }).join('\n');

    try {
      var embed = this.roundMessage.embeds[0];
      var updated = EmbedBuilder.from(embed);
      var fields = updated.data.fields || [];
      var subField = fields.find(function (f) { return f.name === '📬 Submissions'; });
      if (subField) subField.value = lines || '*(none yet)*';
      await this.roundMessage.edit({ embeds: [updated] });
    } catch (err) {
      console.error('updateRoundStatus:', err);
    }
  }

  // ── Voting ────────────────────────────────────────────────────────────────────

  // WRITES: this.phase, this.votingOrder, this.roundMessage, this.voteTimer
  async startVoting() {
    var self = this;
    if (this.submitTimer) clearTimeout(this.submitTimer);
    this.phase = 'voting';

    if (this.submissions.size === 0) {
      try { await this.channel.send('😬 Nobody submitted a prompt. Skipping round...'); }
      catch (err) { console.error('startVoting skipMsg:', err); }
      return this.nextRound();
    }

    var subs = Array.from(this.submissions.values());
    // Shuffle for anonymity
    subs.sort(function () { return Math.random() - 0.5; });

    var letters = ['🅰️', '🅱️', '🇨', '🇩', '🇪', '🇫', '🇬', '🇭', '🇮'];
    var responseList = subs.map(function (s, i) {
      return `${letters[i]} **Prompt ${i + 1}**\n> ${s.text}`;
    }).join('\n\n');

    var deadline = new Date(Date.now() + VOTE_TIME_MS);

    var embed = new EmbedBuilder()
      .setColor('#00cc55')
      .setTitle(`🗳️ VOTE — Round ${this.round}`)
      .setDescription(`The AI answered:\n> "${this.currentResponse}"\n\nWhich prompt best caused it?\n\n${responseList}`)
      .addFields({ name: '⏱️ Voting closes', value: `<t:${Math.floor(deadline.getTime() / 1000)}:R>` })
      .setFooter({ text: 'Vote anonymously • You can\'t vote for your own prompt • Results shown after' });

    var buttons = subs.map(function (s, i) {
      return new ButtonBuilder()
        .setCustomId(`vote_${s.id}`)
        .setLabel(`Prompt ${i + 1}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(letters[i]);
    });

    // Discord allows max 5 buttons per row
    var rows = [];
    for (var i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    if (this.roundMessage) {
      try { await this.roundMessage.delete(); } catch (err) { console.error('startVoting deleteRound:', err); }
    }
    try {
      this.roundMessage = await this.channel.send({ embeds: [embed], components: rows });
    } catch (err) {
      console.error('startVoting send:', err);
    }

    // Store shuffled order for the reveal
    this.votingOrder = subs;

    this.voteTimer = setTimeout(function () {
      if (self.phase === 'voting') {
        self.resolveRound().catch(function (err) { console.error('voteTimer resolveRound:', err); });
      }
    }, VOTE_TIME_MS);
  }

  // WRITES: this.votes
  castVote(voterId, submissionId) {
    if (this.phase !== 'voting') return { message: '❌ Voting is closed.', ephemeral: true };
    var player = this.players.find(function (p) { return p.id === voterId; });
    if (!player) return { message: '❌ You\'re not in this game.', ephemeral: true };

    var ownerId = this.ownerOf(submissionId);
    if (!ownerId) return { message: '❌ Invalid prompt.', ephemeral: true };
    if (ownerId === voterId) return { message: '❌ You can\'t vote for your own prompt!', ephemeral: true };
    if (this.votes.has(voterId)) return { message: '🔒 Your vote is already locked in!', ephemeral: true };

    this.votes.set(voterId, submissionId);

    // Everyone votes — round resolves once every player has voted
    var allVoted = this.votes.size >= this.players.length;
    return { message: '🔒 Vote locked in!', ephemeral: true, allVoted: allVoted };
  }

  // ── Round Resolution ──────────────────────────────────────────────────────────

  // READS: this.submissions
  ownerOf(submissionId) {
    var found = null;
    this.submissions.forEach(function (s, uid) { if (s.id === submissionId) found = uid; });
    return found;
  }

  // WRITES: this.phase, this.players[].score, this.roundMessage
  async resolveRound() {
    var self = this;
    if (this.voteTimer) clearTimeout(this.voteTimer);
    this.phase = 'resolving';

    // Tally votes: submissionId -> count
    var tally = new Map();
    this.votes.forEach(function (subId) { tally.set(subId, (tally.get(subId) || 0) + 1); });

    var subs = this.votingOrder || Array.from(this.submissions.values());
    var results = subs.map(function (s) {
      return { text: s.text, id: s.id, username: s.username, votes: tally.get(s.id) || 0 };
    }).sort(function (a, b) { return b.votes - a.votes; });

    var maxVotes = results.length > 0 ? results[0].votes : 0;
    var winners = results.filter(function (r) { return r.votes === maxVotes; });

    var winnerText = '';
    if (maxVotes === 0) {
      winnerText = '🤷 No votes landed — the AI keeps its secret. No points this round.';
    } else if (winners.length === 1) {
      // DECISION: single top-voted prompt wins +1
      var wId = this.ownerOf(winners[0].id);
      var wPlayer = wId ? this.players.find(function (p) { return p.id === wId; }) : null;
      if (wPlayer) {
        wPlayer.score += 1;
        winnerText = `🏆 **${wPlayer.username}** recovered it best! (+1 point)`;
      }
    } else {
      // DECISION: on a tie, EVERY top-voted prompt scores +1 (no dealer exists to break ties anymore)
      var names = [];
      winners.forEach(function (w) {
        var id = self.ownerOf(w.id);
        var pl = id ? self.players.find(function (p) { return p.id === id; }) : null;
        if (pl) { pl.score += 1; names.push(pl.username); }
      });
      winnerText = `🤝 **TIE!** ${names.join(' & ')} each recovered it (+1 each).`;
    }

    var breakdown = results.map(function (r) {
      var id = self.ownerOf(r.id);
      var name = id ? (self.players.find(function (p) { return p.id === id; }) || {}).username || 'Unknown' : 'Unknown';
      return `**${name}** (${r.votes} vote${r.votes !== 1 ? 's' : ''})\n> ${r.text}`;
    }).join('\n\n');

    var embed = new EmbedBuilder()
      .setColor('#00ff66')
      .setTitle(`📊 Round ${this.round} — The Recovered Prompts`)
      .setDescription(`The AI answered:\n> "${this.currentResponse}"\n\n${breakdown}`)
      .addFields({ name: '🎉 Result', value: winnerText })
      .setFooter({ text: 'Next round starting soon...' });

    if (this.roundMessage) {
      try { await this.roundMessage.edit({ embeds: [embed], components: [] }); }
      catch (err) { console.error('resolveRound editReveal:', err); }
    }

    try { await this.channel.send({ embeds: [this.buildScoreboardEmbed()] }); }
    catch (err) { console.error('resolveRound scoreboard:', err); }

    // Brief pause, then next round
    setTimeout(function () {
      self.nextRound().catch(function (err) { console.error('resolveRound nextRound:', err); });
    }, 8000);
  }

  // ── Scoreboard ────────────────────────────────────────────────────────────────

  // READS: this.players
  buildScoreboardEmbed() {
    var sorted = this.players.slice().sort(function (a, b) { return b.score - a.score; });
    var board = sorted.map(function (p, i) {
      var medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      return `${medal} **${p.username}** — ${p.score} pt${p.score !== 1 ? 's' : ''}`;
    }).join('\n');

    return new EmbedBuilder()
      .setColor('#00cc55')
      .setTitle(`📋 Scoreboard — Round ${this.round}`)
      .setDescription(board || 'No scores yet.')
      .setFooter({ text: `Round ${this.round} complete` });
  }

  // WRITES: this.phase
  endGame(reason) {
    if (this.submitTimer) clearTimeout(this.submitTimer);
    if (this.voteTimer) clearTimeout(this.voteTimer);
    this.phase = 'ended';
    try {
      this.channel.send(`🛑 **Game Over.** ${reason}\n\n${this.buildScoreboardEmbed().data.description}`);
    } catch (err) {
      console.error('endGame:', err);
    }
  }
}

module.exports = GameManager;
