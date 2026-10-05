#!/bin/bash
# Isola a rede do sandbox (10.200.0.0/16): libera DNS publico, bloqueia metadata
# e todas as redes internas (VPC/RFC1918). Idempotente (flush + rebuild).
set -e
SBX=10.200.0.0/16
iptables -N DOCKER-USER 2>/dev/null || true
iptables -F DOCKER-USER
iptables -A DOCKER-USER -m state --state RELATED,ESTABLISHED -j RETURN
for ip in 8.8.8.8 1.1.1.1; do
  iptables -A DOCKER-USER -s $SBX -d $ip -p udp --dport 53 -j RETURN
  iptables -A DOCKER-USER -s $SBX -d $ip -p tcp --dport 53 -j RETURN
done
iptables -A DOCKER-USER -s $SBX -d 169.254.0.0/16 -j DROP
iptables -A DOCKER-USER -s $SBX -d 172.31.0.0/16 -j DROP
iptables -A DOCKER-USER -s $SBX -d 10.0.0.0/8     -j DROP
iptables -A DOCKER-USER -s $SBX -d 172.16.0.0/12  -j DROP
iptables -A DOCKER-USER -s $SBX -d 192.168.0.0/16 -j DROP
iptables -A DOCKER-USER -j RETURN
