# A typical "it works on my laptop" Node image. Do not copy.
# expect: DD001 DD003 DD008 DD009 DD011 DD012 DD019 DD020 DD029 DD032 DD033 DD034
FROM node
WORKDIR app
COPY . .
RUN npm install
ENV NODE_ENV=development
ENV API_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz
RUN chmod -R 777 /app
EXPOSE 22 3000
CMD npm start
