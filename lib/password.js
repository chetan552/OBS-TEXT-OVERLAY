// =============================================================================
// Generated passwords — readable words, dictated to volunteers over the phone
// =============================================================================
// 4 words + 3 digits is ~35 bits. That makes offline guessing of a leaked
// channels.json infeasible (scrypt costs ~50 ms per guess) while staying
// sayable aloud. The wordlist lives here; views/admin.html has its own copy
// for the Generate button (kept in sync — same words, same format).

const crypto = require("crypto");

const WORDS = [
  "anchor", "beacon", "cedar", "harbor", "lantern", "meadow",
  "quartz", "ridge", "summit", "willow", "amber", "cobalt",
  "arbor", "autumn", "basket", "boulder", "breeze", "candle",
  "canyon", "comet", "cottage", "daisy", "dove", "ember",
  "falcon", "fern", "firefly", "flint", "forest", "frost",
  "garden", "garnet", "glacier", "grove", "harvest", "hazel",
  "heron", "hollow", "horizon", "ivy", "juniper", "kestrel",
  "lake", "lily", "loam", "maple", "marsh", "mist",
  "moon", "moss", "oak", "ocean", "olive", "orchard",
  "otter", "pebble", "pine", "pond", "prairie", "robin",
  "rose", "sparrow", "spring", "stone", "storm", "stream",
  "sunset", "thistle", "thunder", "timber", "trail", "tulip",
  "valley", "vine", "walnut", "wren",
];

function suggestPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${pick()}-${100 + crypto.randomInt(900)}`;
}

module.exports = { suggestPassword, WORDS };
