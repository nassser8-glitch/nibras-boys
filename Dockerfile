FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ملفات الخادم المطلوبة فعليًا. أي require() في server.js يجب أن يكون ملفه
# مُدرجًا هنا، وإلا فشل الإقلاع على Render.
COPY server.js db.js seed.js notes-privacy.js transfers-privacy.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV WEBROOT=public
ENV TRUST_PROXY=1
ENV FORCE_HTTPS=1

EXPOSE 3000

CMD ["node", "server.js"]
