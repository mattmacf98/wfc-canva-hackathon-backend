FROM node:18

WORKDIR /usr/src/app

COPY package.json ./

RUN npm install

COPY .env ./

COPY ./dist ./dist

ENV NODE_ENV production

EXPOSE 3001

CMD ["node", "./dist/index.js"]
