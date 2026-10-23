FROM node:18

WORKDIR /app

COPY package.json ./
RUN npm install -g bun
RUN bun i
COPY . .
# para produção:
RUN bun run build

EXPOSE 3000
# para produção:
CMD ["bun", "start"]
# para dev:
# CMD ["bun", "dev"]
