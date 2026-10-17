import { createHash } from 'node:crypto';
import { readAttachment, saveImage } from '../attachments.ts';
import { botAvatarUrlFromStoredPath, botAvatarUrlSchema } from '../../shared/bot-avatar.ts';
import { templateAvatarSchema, type TemplateAvatar } from '../../shared/template-avatar.ts';

export function captureTemplateAvatar(url?: string): TemplateAvatar | undefined {
  if (!url) return undefined;
  if (!botAvatarUrlSchema.safeParse(url).success) throw new Error('The bot avatar is not a stored image. Choose its image again before saving the template.');
  const image = readAttachment(url.slice('/api/attachments/'.length));
  if (!image) throw new Error('The bot avatar image is missing. Choose its image again before saving the template.');
  return templateAvatarSchema.parse({ mime: image.mime, data: image.bytes.toString('base64') });
}

export function storeTemplateAvatar(avatar: TemplateAvatar): string {
  const image = templateAvatarSchema.parse(avatar);
  const bytes = Buffer.from(image.data, 'base64');
  const hash = createHash('sha256').update(image.mime).update(bytes).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return botAvatarUrlFromStoredPath(saveImage(bytes, image.mime, id).path)!;
}
