FROM node:18

WORKDIR /usr/src/app

COPY package.json ./

RUN npm install

COPY .env ./

COPY ./dist ./dist

EXPOSE 3001

CMD ["node", "./dist/index.js"]
