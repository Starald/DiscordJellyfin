import {
  GuildMember,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type VoiceBasedChannel,
} from 'discord.js';

/** Возвращает голосовой канал, в котором сейчас находится вызвавший команду пользователь. */
export async function getUserVoiceChannel(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
): Promise<VoiceBasedChannel | null> {
  if (!interaction.guild) return null;

  let member = interaction.member;
  if (!(member instanceof GuildMember)) {
    member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }
  if (!(member instanceof GuildMember)) return null;

  return member.voice.channel;
}
