// main.gs — GroupMe utility bot for Google Apps Script
// Paste this into your main script file in script.google.com

// ---------------------------------------------------------------------------
// Config — set these in Project Settings → Script Properties
// ---------------------------------------------------------------------------
var props        = PropertiesService.getScriptProperties();
var ADMIN_TOKEN    = props.getProperty("GROUPME_TOKEN")   || "";
var ADMIN_UID      = props.getProperty("ADMIN_UID")       || "";
var FALLBACK_TOKEN = props.getProperty("FALLBACK_TOKEN")  || "";
var AUTH_CODE      = props.getProperty("AUTH_CODE")       || "";
var BOT_MAP        = JSON.parse(props.getProperty("BOT_MAP") || "{}");
var READ_TOKENS = [ADMIN_TOKEN, FALLBACK_TOKEN].filter(function(t) { return !!t; });
// A fallback account can read groups that the admin account cannot.

// Copilot is a built-in GroupMe assistant present in every group with this user ID.
var COPILOT_UID = "128934125";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------
var HELP = [
  "commands are not case-sensitive.",
  "Chat (Copilot): +[Your question](ex: + tell me a joke)",
  "Roster of this group: -list",
  "Translate: -translate [lang code] [text](ex: -translate es hello)",
  "== Weather & Zmanim ==",
  "(Location defaults to Jerusalem if not provided)",
  "7-Day Forecast: -weather [city or zip]",
  "Hourly Forecast: -weather hour [city or zip]",
  "Zmanim: -zmanim [city or zip]",
  "== Utilities ==",
  "Currency: -currency [amount] [from] [to](ex: -currency 100 USD ILS)(defaults to 1 usd to ils; up to 10 targets)",
  "Stocks: -stock [ticker](ex: -stock AAPL)(default: spym - s&p. works for crypto.)",
  "Spell Check: -spellcheck [your text here]",
  "Dictionary: -dictionary [word]",
  "Temp Converter: -temp [number] [F or C](ex: -temp 100 C)",
  "",
  "credits: @flipphoneguy and @jayjaytech"
].join("\n");

var ADMIN_HELP = [
  "Admin commands:",
  "-@ <group id or .> <name> [message]  — @mention a member (. = current group)",
  "-add <nickname> <phone> [group id or .]  — add a member",
  "-remove <name or id> [group id or .]  — remove a member",
  "-groups  — list your groups",
  "-members [name/phone/id]  — detailed member list (defaults to this group)"
].join("\n");

// ---------------------------------------------------------------------------
// Webhook entry point
// ---------------------------------------------------------------------------
function doPost(e) {
  if (AUTH_CODE && e.parameter.auth !== AUTH_CODE) {
    return ContentService.createTextOutput("denied");
  }
  var data = JSON.parse(e.postData.contents);
  if (!data || !data.text) return ContentService.createTextOutput("no data");
  if (data.sender_type === "bot") return ContentService.createTextOutput("ok");

  var route = e.parameter.route || "groupme";
  calculateResponse(data.text, data.user_id, data.group_id, route);
  return ContentService.createTextOutput("ok");
}

// ---------------------------------------------------------------------------
// GroupMe API helpers
// ---------------------------------------------------------------------------

function botSend(botId, message) {
  if (!botId || !message) return;
  UrlFetchApp.fetch("https://api.groupme.com/v3/bots/post", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ bot_id: botId, text: message }),
    muteHttpExceptions: true
  });
}

function userSend(token, group, message, mention) {
  if (mention === undefined) mention = true;
  var url = "https://api.groupme.com/v3/groups/" + group + "/messages?token=" + token;
  var body;

  if (mention) {
    var name = message.split(" ")[0];
    var uids;

    if (name === "Copilot") {
      uids = [COPILOT_UID];
    } else {
      var r = UrlFetchApp.fetch("https://api.groupme.com/v3/groups/" + group + "?token=" + token, { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) return "couldn't fetch members.\n" + r.getResponseCode() + " " + r.getContentText();
      var members = JSON.parse(r.getContentText()).response.members;

      if (name === "all") {
        uids = members.map(function(m) { return m.user_id; });
      } else {
        var match = null;
        for (var i = 0; i < members.length; i++) {
          if (members[i].nickname === name || members[i].user_id === name) {
            match = members[i];
            break;
          }
        }
        if (!match) return "couldn't find user '" + name + "'";
        uids = [match.user_id];
        name = match.nickname;
        message = name + " " + message.split(" ").slice(1).join(" ");
      }
    }

    var loci = uids.map(function() { return [0, name.length + 1]; });
    body = {
      message: {
        source_guid: String(Date.now()),
        text: "@" + message,
        attachments: [{ type: "mentions", user_ids: uids, loci: loci }]
      }
    };
  } else {
    body = { message: { source_guid: String(Date.now()), text: message } };
  }

  var r2 = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (r2.getResponseCode() !== 201) return "couldn't send message.\n" + r2.getResponseCode() + " " + r2.getContentText();
  return null;
}

function addMember(token, group, nickname, number) {
  var phone = number.startsWith("+") ? number : "+1" + number;
  var r = UrlFetchApp.fetch(
    "https://api.groupme.com/v3/groups/" + group + "/members/add?token=" + token,
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ members: [{ nickname: nickname, phone_number: phone }] }),
      muteHttpExceptions: true
    }
  );
  if (r.getResponseCode() !== 202) return "failed to add " + nickname + " (" + phone + ")\n" + r.getResponseCode() + " " + r.getContentText();
  return "added " + nickname;
}

function removeMember(token, group, nameOrId) {
  var r = UrlFetchApp.fetch("https://api.groupme.com/v3/groups/" + group + "?token=" + token, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) {
    return "couldn't fetch group " + group + "\n" + r.getResponseCode() + " " + r.getContentText();
  }
  var members = JSON.parse(r.getContentText()).response.members;
  var match = null;
  for (var i = 0; i < members.length; i++) {
    if (members[i].nickname === nameOrId || members[i].user_id === nameOrId) {
      match = members[i];
      break;
    }
  }
  if (!match) return "no member found for '" + nameOrId + "'";

  var r2 = UrlFetchApp.fetch(
    "https://api.groupme.com/v3/groups/" + group + "/members/" + match.id + "/remove?token=" + token,
    { method: "post", muteHttpExceptions: true }
  );
  if (r2.getResponseCode() !== 200) return "error removing '" + nameOrId + "'\n" + r2.getResponseCode() + " " + r2.getContentText();
  return "removed " + nameOrId;
}

function fetchGroups(token) {
  var r = UrlFetchApp.fetch(
    "https://api.groupme.com/v3/groups?token=" + token + "&per_page=30&omit=memberships",
    { muteHttpExceptions: true }
  );
  var groups = JSON.parse(r.getContentText()).response || [];
  if (!groups.length) return "no groups found.";
  return groups.map(function(g) { return g.name + ": " + g.group_id + ". " + g.phone_number; }).join("\n");
}

function listMembers(group) {
  for (var i = 0; i < READ_TOKENS.length; i++) {
    var r = UrlFetchApp.fetch("https://api.groupme.com/v3/groups/" + group + "?token=" + READ_TOKENS[i], { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) continue;
    var g = JSON.parse(r.getContentText()).response;
    var lines = [g.name, ""];
    g.members.forEach(function(m) {
      var tags = [];
      if ((m.roles || []).some(function(role) { return role === "admin" || role === "owner"; })) tags.push("admin");
      if (m.muted) tags.push("muted");
      lines.push(m.nickname + (tags.length ? " (" + tags.join(", ") + ")" : ""));
    });
    return lines.join("\n");
  }
  return null;
}

// Copilot replies bypass bot callbacks.  Poll and echo the response so SMS
// users receive it too.  This stays within the Apps Script execution window.
function echoCopilotReply(token, group, botId, startedAt) {
  if (!token || !botId) return;
  for (var attempt = 0; attempt < 15; attempt++) {
    Utilities.sleep(attempt === 0 ? 2000 : 700);
    var r = UrlFetchApp.fetch("https://api.groupme.com/v3/groups/" + group + "/messages?token=" + token + "&limit=20", { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) continue;
    var messages = (JSON.parse(r.getContentText()).response || {}).messages || [];
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.user_id === COPILOT_UID && m.text && Number(m.created_at) >= startedAt) {
        botSend(botId, m.text);
        return;
      }
    }
  }
}

function fetchMembers(token, query) {
  var r = UrlFetchApp.fetch(
    "https://api.groupme.com/v3/groups?token=" + token + "&per_page=30",
    { muteHttpExceptions: true }
  );
  var groups = JSON.parse(r.getContentText()).response || [];
  var target = null;
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].name === query || groups[i].phone_number === query || groups[i].group_id === query) {
      target = groups[i];
      break;
    }
  }
  if (!target) return "no group found for '" + query + "'";

  var out = target.name + " " + target.group_id + " " + target.phone_number + "\n\n";
  target.members.forEach(function(m) {
    var muted  = m.muted       ? " muted"      : "";
    var kicked = m.autokicked  ? " autokicked" : "";
    var roles  = JSON.stringify(m.roles) !== '["user"]' ? " " + m.roles.join(",") : "";
    out += m.nickname + " (" + m.name + ")" + muted + kicked + roles + " uid: " + m.user_id + " mid: " + m.id + "\n";
  });
  return out;
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

function handleAdmin(text, groupId) {
  var parts = text.trim().split(/\s+/);
  var cmd   = parts[0].toLowerCase();

  if (text.startsWith("-@")) {
    if (parts.length < 2) return "usage: -@ <group id or .> <name> [message]";
    var group = parts[0].slice(2) === "." ? groupId : parts[0].slice(2);
    return userSend(ADMIN_TOKEN, group, parts.slice(1).join(" "));
  }
  if (cmd === "-add") {
    if (parts.length < 3) return "usage: -add <nickname> <phone> [group id or .]";
    var group = groupId;
    var phone = parts[parts.length - 1];
    var nickname = parts.slice(1, -1).join(" ");
    if (parts.length > 3) {
      group = parts[parts.length - 1] === "." ? groupId : parts[parts.length - 1];
      phone = parts[parts.length - 2];
      nickname = parts.slice(1, -2).join(" ");
    }
    return addMember(ADMIN_TOKEN, group, nickname, phone);
  }
  if (cmd === "-remove") {
    if (parts.length < 2) return "usage: -remove <name or id> [group id or .]";
    var group = groupId;
    var name = parts.slice(1).join(" ");
    if (parts.length > 2) {
      group = parts[parts.length - 1] === "." ? groupId : parts[parts.length - 1];
      name = parts.slice(1, -1).join(" ");
    }
    return removeMember(ADMIN_TOKEN, group, name);
  }
  if (cmd === "-groups")  return fetchGroups(ADMIN_TOKEN);
  if (cmd === "-members") {
    return fetchMembers(ADMIN_TOKEN, parts.length > 1 && parts[1] !== "." ? parts.slice(1).join(" ") : groupId);
  }
  if (cmd === "--help") return ADMIN_HELP;
  return null;
}

function handleCommand(text, groupId) {
  var low   = text.toLowerCase();
  var parts = text.trim().split(/\s+/);

  if (low.startsWith("-help"))       return HELP;
  if (low.startsWith("-list"))       return listMembers(groupId) || "couldn't fetch member list.";
  if (low.startsWith("-currency"))   return currency.apply(null, parts.slice(1));
  if (low.startsWith("-weather"))    return weather(text.slice(9).trim() || undefined);
  if (low.startsWith("-zmanim"))     return zmanim(text.slice(8).trim()  || undefined);
  if (low.startsWith("-temp"))       return parts[2] ? temp(parts[1], parts[2]) : "invalid input";
  if (low.startsWith("-stock"))      return stock(text.slice(7).trim()   || undefined);
  if (low.startsWith("-spellcheck")) return text.slice(12).trim() ? spellcheck(text.slice(12).trim()) : "invalid input";
  if (low.startsWith("-dictionary")) return dictionary(text.slice(12).trim());
  if (low.startsWith("-translate"))  return parts[2] ? translate(parts[1], parts.slice(2).join(" ")) : "invalid input";
  return null;
}

function calculateResponse(text, senderId, groupId, route) {
  var botId  = BOT_MAP[groupId];
  var result = null;

  if (text.startsWith("+") && route !== "general") {
    var token = senderId === ADMIN_UID ? ADMIN_TOKEN : (FALLBACK_TOKEN || ADMIN_TOKEN);
    if (token) {
      var startedAt = Math.floor(Date.now() / 1000);
      result = userSend(token, groupId, "Copilot " + text.slice(1));
      if (!result) echoCopilotReply(token, groupId, botId, startedAt);
    }
  } else if (senderId && senderId === ADMIN_UID && ADMIN_TOKEN) {
    result = handleAdmin(text, groupId);
  }

  if (result === null) result = handleCommand(text, groupId);
  if (result && botId) botSend(botId, result);
}
