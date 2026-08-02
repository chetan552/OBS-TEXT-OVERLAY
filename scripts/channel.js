#!/usr/bin/env node
// =============================================================================
// Channel admin CLI
// =============================================================================
// The web panel at /admin covers day-to-day work. This exists for the cases
// where a browser isn't handy: bootstrapping the first channel over SSH,
// scripting an onboarding, or recovering when ADMIN_PASSWORD has been lost.
//
//   npm run channel -- list
//   npm run channel -- add <id> "<Church name>" [password]
//   npm run channel -- password <id> [password]
//   npm run channel -- rotate <id>
//   npm run channel -- disable <id>
//   npm run channel -- enable <id>
//   npm run channel -- remove <id>
//
// Changes take effect on the next connection; a running server re-reads
// nothing, so restart it after editing channels from here.

// The CLI needs the same DATA_DIR and PUBLIC_URL the server uses, so it reads
// .env too — otherwise it would happily manage a different channel file.
require("../lib/env").loadEnv();

const store = require("../lib/store");
const { randomToken } = require("../lib/auth");

const BASE = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");

store.load();

const [command, ...args] = process.argv.slice(2);

/** Readable, phone-friendly password — these get dictated to volunteers. */
function suggestPassword() {
  const words = ["anchor", "beacon", "cedar", "harbor", "lantern", "meadow",
                 "quartz", "ridge", "summit", "willow", "amber", "cobalt"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${100 + Math.floor(Math.random() * 900)}`;
}

function printChannel(channel, password) {
  console.log("");
  console.log(`  ${channel.name}  (${channel.id})${channel.disabled ? "   [disabled]" : ""}`);
  console.log(`    Control   ${BASE}/c/${channel.id}`);
  console.log(`    Overlay   ${BASE}/v/${channel.viewToken}/overlay.html`);
  console.log(`    Screen    ${BASE}/v/${channel.viewToken}/screen.html`);
  if (password) console.log(`    Password  ${password}`);
}

function requireId(name) {
  if (!name) {
    console.error("Error: a channel id is required");
    process.exit(1);
  }
  return name;
}

try {
  switch (command) {
    case "list": {
      const channels = store.listChannels();
      if (channels.length === 0) {
        console.log("No channels yet. Create one with:  npm run channel -- add <id> \"<Name>\"");
        break;
      }
      channels.forEach((channel) => printChannel(channel));
      console.log("");
      break;
    }

    case "add": {
      const [id, name, provided] = args;
      if (!id || !name) {
        console.error('Usage: npm run channel -- add <id> "<Church name>" [password]');
        process.exit(1);
      }
      const password = provided || suggestPassword();
      const channel = store.createChannel({ id, name, password });
      console.log("Channel created. Send these to the church:");
      printChannel(channel, password);
      console.log("\n  The overlay and screen links are secrets — anyone with them can watch.\n");
      break;
    }

    case "password": {
      const id = requireId(args[0]);
      const password = args[1] || suggestPassword();
      store.setPassword(id, password);
      console.log(`Password for "${id}" updated to:  ${password}`);
      break;
    }

    case "rotate": {
      const id = requireId(args[0]);
      const channel = store.rotateViewToken(id);
      console.log("New view links (the old ones no longer work):");
      printChannel(channel);
      console.log("");
      break;
    }

    case "disable":
    case "enable": {
      const id = requireId(args[0]);
      store.setDisabled(id, command === "disable");
      console.log(`Channel "${id}" ${command}d.`);
      break;
    }

    case "remove": {
      const id = requireId(args[0]);
      store.deleteChannel(id);
      console.log(`Channel "${id}" deleted.`);
      break;
    }

    case "secret": {
      // Handy when moving the install to another machine and you want the
      // signing key in an env var instead of the data directory.
      console.log(randomToken(48));
      break;
    }

    default:
      console.log(`
TextPresenter channel admin

  npm run channel -- list
  npm run channel -- add <id> "<Church name>" [password]
  npm run channel -- password <id> [password]
  npm run channel -- rotate <id>
  npm run channel -- disable <id>
  npm run channel -- enable <id>
  npm run channel -- remove <id>
  npm run channel -- secret

Restart the server after making changes here.
`);
      process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
