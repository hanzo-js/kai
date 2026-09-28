// A home assistant: a spoken request becomes one command from a closed set; risky commands wait for a spoken yes.
import { Kai, choice } from "@hanzo/kai";

// Every command the house accepts, as device.action, and two ways out.
const COMMANDS = {
  "lights.on": "turn the lights on",
  "lights.off": "turn the lights off",
  "lights.up": "make the lights brighter",
  "lights.down": "dim the lights",
  "lights.status": "say whether the lights are on",
  "thermostat.up": "make it warmer",
  "thermostat.down": "make it cooler",
  "thermostat.status": "say what the heating is set to",
  "front_door.lock": "lock the front door",
  "front_door.unlock": "unlock the front door",
  "front_door.status": "say whether the front door is locked",
  "garage.open": "open the garage door",
  "garage.close": "close the garage door",
  "garage.status": "say whether the garage door is open",
  "oven.on": "turn the oven on or preheat it",
  "oven.off": "turn the oven off",
  "oven.status": "say whether the oven is on",
  "alarm.arm": "turn the security alarm on",
  "alarm.disarm": "turn the security alarm off",
  "alarm.status": "say whether the alarm is on",
  "speaker.on": "play music",
  "speaker.off": "stop the music",
  "speaker.up": "turn the music up",
  "speaker.down": "turn the music down",
  several: "two or more of these commands in one request",
  chat: "small talk, or something the house cannot do",
} as const;
type Command = keyof typeof COMMANDS;

const questions = { command: choice("Which command does `heard` ask for?", COMMANDS) };

// The house's rules, in code: which commands wait for a spoken yes, and how sure Kai must be.
const RISKY = new Set<Command>(["front_door.unlock", "garage.open", "alarm.disarm", "oven.on"]);
const SURE = 0.5;
const RISKY_SURE = 0.9;

function plan(a: { choice: Command; confidence: number }): string {
  if (a.confidence < SURE) return "ask again";
  if (a.choice === "several") return "one at a time";
  if (a.choice === "chat") return "chat";
  if (a.choice.endsWith(".status")) return `answer ${a.choice}`;
  if (RISKY.has(a.choice)) return a.confidence >= RISKY_SURE ? `confirm ${a.choice}` : "ask again";
  return `do ${a.choice}`;
}

// Spoken requests as a recognizer hands them over, and the plan their author expects.
const HEARD: [string, string][] = [
  ["turn off the lights in the living room", "do lights.off"],
  ["unlock the front door", "confirm front_door.unlock"],
  ["is the garage open", "answer garage.status"],
  ["make it a bit warmer in here", "do thermostat.up"],
  ["open the garage and turn the alarm off", "one at a time"],
  ["preheat the oven to four hundred", "confirm oven.on"],
  ["arm the alarm we're heading out", "do alarm.arm"],
  ["tell me a joke", "chat"],
  ["uh can you do the the door thing", "ask again"],
];

async function main() {
  // Each 429 waits out its Retry-After, up to 10 times: a run of calls can meet the rate limit.
  const kai = new Kai({ retry: { maxRetries: 10 } });
  let match = 0;
  console.log("heard".padEnd(42) + "command".padEnd(19) + "p     conf  plan");
  for (const [heard, want] of HEARD) {
    const a = (await kai.decide({ state: { heard }, questions })).answers.command;
    const got = plan(a);
    match += +(got === want);
    console.log(heard.padEnd(42) + a.choice.padEnd(19) + a.probabilities[a.choice].toFixed(2).padEnd(6) +
      a.confidence.toFixed(2).padEnd(6) + got + (got === want ? "" : `  (want: ${want})`));
  }
  console.log(`${match} of ${HEARD.length} plans as expected. Nothing ran: "do" and "confirm" go to the house controller.`);
}

main();
