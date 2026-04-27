const axios = require("axios");

const DISCORD_API = "https://discord.com/api/v10";

/* GET USER (SAFE) */
async function getDiscordUser(accessToken) {
  try {
    const res = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return res.data;
  } catch (err) {
    console.log("Discord user fetch failed");
    return null;
  }
}

/* GET GUILD MEMBER (SAFE - BOT) */
async function getGuildMember(userId, guildId) {
  try {
    const res = await axios.get(
      `${DISCORD_API}/guilds/${guildId}/members/${userId}`,
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        },
      }
    );

    return res.data;
  } catch (err) {
    return null;
  }
}

/* SAFE ADMIN CHECK */
async function isAdmin(userId, guildId) {
  const member = await getGuildMember(userId, guildId);

  if (!member) return false;

  return member.roles?.includes(process.env.ADMIN_ROLE_ID);
}

module.exports = {
  getDiscordUser,
  getGuildMember,
  isAdmin,
};