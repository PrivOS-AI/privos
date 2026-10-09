# privos-netguard: docker-user-rules.sh in --loop mode for Docker Desktop
# (compose.desktop.yml). Runs with host networking inside the Desktop VM and
# applies the same DOCKER-USER rules the Linux installer applies on the host.
# The same image runs the one-shot `privos-init` volume-ownership step.
# Build context: the bundle repository root.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache bash iptables iptables-legacy
# PRIVOS_NETGUARD: --present / --clear pick the iptables backend the daemon uses.
ENV PRIVOS_NETGUARD=1
COPY docker-user-rules.sh /usr/local/sbin/privos-docker-user-rules.sh
ENTRYPOINT ["/usr/local/sbin/privos-docker-user-rules.sh"]
