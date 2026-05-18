# Pinned: v1.152.1 (matrix_authentication_service stable config, requires >= 1.136)
FROM matrixdotorg/synapse:v1.152.1
RUN apt update && apt install wget -y && apt clean
RUN wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq && chmod +x /usr/bin/yq
COPY ./entrypoints/matrix_server.sh /matrix_server.sh
ENTRYPOINT ["/matrix_server.sh"]
