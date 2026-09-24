export type EmojiCategory = {
  id: string;
  label: string;
  icon: string;
  emojis: string[];
};

function emojis(value: string) {
  return value.trim().split(/\s+/);
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "recentes",
    label: "Mais usados",
    icon: "🕘",
    emojis: emojis("😀 😂 🤣 😊 😍 🥰 😘 😎 🤩 🥳 😭 😡 👍 👎 ❤️ 🔥 🎉 🙏 👏 💯 ✅"),
  },
  {
    id: "rostos",
    label: "Rostos e emoções",
    icon: "😀",
    emojis: emojis("😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🤫 🤥 😶 😐 😑 😬 🫠 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕"),
  },
  {
    id: "gestos",
    label: "Pessoas e gestos",
    icon: "👋",
    emojis: emojis("👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 👃 🧠 🫀 🫁 🦷 👀 👁️ 👅 👄 🫦 👶 🧒 👦 👧 🧑 👨 👩 🧔 👱 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷"),
  },
  {
    id: "animais",
    label: "Animais e natureza",
    icon: "🐶",
    emojis: emojis("🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐻‍❄️ 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🪳 🦟 🦗 🕷️ 🦂 🐢 🐍 🦎 🐙 🦑 🦀 🐠 🐟 🐡 🐬 🐳 🦈 🐊 🐅 🐆 🦓 🦍 🦧 🐘 🦛 🦏 🐪 🦒 🦘 🦬 🐎 🐄 🐖 🐏 🐐 🦌 🐕 🐈 🪶 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🎍 🪴 🎋 🍃 🍂 🍁 🍄 🌾 💐 🌷 🌹 🌺 🌸 🌼 🌻 ☀️ 🌤️ 🌈 ⭐ 🌟 ✨ ⚡ 🔥 ❄️"),
  },
  {
    id: "comidas",
    label: "Comidas e bebidas",
    icon: "🍕",
    emojis: emojis("🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥪 🥙 🧆 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍚 🍙 🍘 🍥 🥠 🥡 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍮 🍯 🍼 🥛 ☕ 🫖 🍵 🧃 🥤 🧋 🍺 🍻 🥂 🍷 🍸 🍹 🧉 🧊"),
  },
  {
    id: "atividades",
    label: "Atividades e lugares",
    icon: "⚽",
    emojis: emojis("⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏊 🚣 🧗 🚴 🏆 🥇 🥈 🥉 🎖️ 🏅 🎫 🎪 🤹 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🧩 🚗 🚕 🚌 🚑 🚒 🚲 ✈️ 🚀 🛸 🚁 ⛵ 🚢 🗺️ 🗿 🗽 🗼 🏰 🏖️ 🏝️ 🏙️ 🌅 🌃"),
  },
  {
    id: "objetos",
    label: "Objetos",
    icon: "💡",
    emojis: emojis("⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙️ ⏰ ⌛ 🔋 🔌 💡 🔦 🕯️ 🧯 💸 💵 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🪛 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ 🛡️ 🚬 ⚰️ 🔮 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🧬 🦠 🧹 🧺 🧻 🚽 🚿 🛁 🧼 🪥 🪒 🧽 🪣 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🧸 🖼️ 🛍️ 🎁 🎈 🎏 ✉️ 📧 📨 📦 📌 📍 📎 ✂️ 📝 ✏️ 🔍 🔒 🔓"),
  },
  {
    id: "simbolos",
    label: "Símbolos e bandeiras",
    icon: "❤️",
    emojis: emojis("❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🔞 📵 ❗ ❓ ‼️ ⁉️ ⚠️ ✅ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏁 🚩 🎌 🏳️ 🏴 🇧🇷 🇵🇹 🇺🇸 🇪🇸 🇫🇷 🇩🇪 🇮🇹 🇯🇵 🇨🇳 🇮🇳 🇦🇷 🇲🇽 🇨🇦"),
  },
];

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉"];

export const ALL_EMOJIS = Array.from(new Set(EMOJI_CATEGORIES.flatMap((category) => category.emojis)));
