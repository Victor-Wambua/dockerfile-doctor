FROM alpine:3.20
ENV NODE_SHA256=3b8b1d7ac1c0e2f0a64d5a5de0b6f8e0b6a0a4f3a2c5e5c3d2a1b0f9e8d7c6b5
ENV VERSION=1.2.3
RUN git clone https://git.example.com/app.git
