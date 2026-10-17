import { z } from 'zod';
import { decodeBase64, pictureMatchesMime } from './package-format.ts';

/** Same image limit as attachment uploads; base64 needs four bytes per three image bytes. */
export const TEMPLATE_AVATAR_MAX_BYTES = 10 * 1024 * 1024;
export const TEMPLATE_AVATAR_ENCODED_MAX = Math.ceil(TEMPLATE_AVATAR_MAX_BYTES / 3) * 4;
export const BOT_TEMPLATE_METADATA_MAX_BYTES = 900_000;
export const BOT_TEMPLATE_MAX_BYTES = BOT_TEMPLATE_METADATA_MAX_BYTES + TEMPLATE_AVATAR_ENCODED_MAX;
export const BOT_TEMPLATE_HTTP_MAX_BYTES = 1_000_000 + TEMPLATE_AVATAR_ENCODED_MAX;
export const templateAvatarSchema = z.object({
  mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string().max(TEMPLATE_AVATAR_ENCODED_MAX).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict().superRefine((value, context) => {
  const bytes = decodeBase64(value.data);
  if (!bytes || bytes.length > TEMPLATE_AVATAR_MAX_BYTES) context.addIssue({ code: 'custom', path: ['data'], message: 'Avatar exceeds the 10 MiB image limit or is not valid base64' });
  else if (!(value.mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6))) : pictureMatchesMime(bytes, value.mime))) context.addIssue({ code: 'custom', path: ['data'], message: 'Avatar image does not match its declared type' });
});
export type TemplateAvatar = z.infer<typeof templateAvatarSchema>;
