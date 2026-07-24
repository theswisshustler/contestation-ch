import { defineMiddleware } from 'astro:middleware';

const canonicalHost = 'contestation.ch';

export const onRequest = defineMiddleware((context, next) => {
  const forwardedHost = context.request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const requestHost = (forwardedHost || context.url.host).split(':')[0]?.toLowerCase();

  if (requestHost === `www.${canonicalHost}`) {
    const destination = new URL(context.url);
    destination.protocol = 'https:';
    destination.hostname = canonicalHost;
    destination.port = '';
    return context.redirect(destination.toString(), 308);
  }

  return next();
});
