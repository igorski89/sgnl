#!/usr/bin/env bash
set -euo pipefail

# Host hardening for 203.0.113.10 (shared with cotenant). See
# docs/SECURITY.md section 2 for the why. Two independent changes:
#
#   1. sshd: PasswordAuthentication no (root is already key-only; this
#      closes password login for every other account).
#   2. Docker-published ports become subject to a default-deny: only
#      80/443 (kamal-proxy) and 465/993 (Stalwart) may receive new
#      connections from the internet. Docker DNATs published ports before
#      ufw's rules see them, so today ufw doesn't control them at all.
#      Rules live in the DOCKER-USER chain (which Docker never flushes),
#      persisted through ufw's after.rules/after6.rules.
#
# Dry run by default (prints what it would do). On the server:
#   ssh root@203.0.113.10 'bash -s' < host/harden.sh            # dry run
#   ssh root@203.0.113.10 'bash -s -- --apply' < host/harden.sh # apply
# Keep a second SSH session open while applying.
#
# Rollback:
#   rm /etc/ssh/sshd_config.d/00-sgnl-hardening.conf && systemctl reload ssh
#   cp /etc/ufw/after.rules.pre-sgnl /etc/ufw/after.rules
#   cp /etc/ufw/after6.rules.pre-sgnl /etc/ufw/after6.rules
#   iptables -F DOCKER-USER; ip6tables -F DOCKER-USER; ufw reload

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

IFACE=eth0                      # public interface (checked 2026-10-07)
ALLOWED_TCP="80 443 465 993"    # kamal-proxy, Stalwart submission + IMAPS
MARKER="# sgnl: DOCKER-USER default-deny"

run() { if $APPLY; then "$@"; else echo "would run: $*"; fi; }

# --- 1. sshd -----------------------------------------------------------
# sshd_config.d is read first-match-wins, so 00- beats any later
# cloud-init drop-in that sets PasswordAuthentication yes.
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-sgnl-hardening.conf
SSHD_CONF='PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password'
if $APPLY; then
  printf '%s\n' "$SSHD_CONF" > "$SSHD_DROPIN"
  sshd -t                                   # refuse to reload a broken config
  systemctl reload ssh
  sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin) '
else
  echo "would write $SSHD_DROPIN:"; printf '  %s\n' "$SSHD_CONF"
fi

# --- 2. DOCKER-USER ----------------------------------------------------
# Traffic arriving on the public interface for a container: allow replies
# to connections the containers opened, allow new connections only to the
# allowed published ports (matched on the pre-DNAT port via conntrack),
# drop the rest. Container egress and container-to-container traffic
# don't enter on $IFACE, so they're untouched.
block() {
  echo "$MARKER"
  echo "*filter"
  echo ":DOCKER-USER - [0:0]"
  echo "-F DOCKER-USER"
  echo "-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  for p in $ALLOWED_TCP; do
    echo "-A DOCKER-USER -i $IFACE -p tcp -m conntrack --ctstate NEW --ctorigdstport $p -j RETURN"
  done
  echo "-A DOCKER-USER -i $IFACE -m conntrack --ctstate NEW,INVALID -j DROP"
  echo "-A DOCKER-USER -j RETURN"
  echo "COMMIT"
}

for f in /etc/ufw/after.rules /etc/ufw/after6.rules; do
  if grep -qF "$MARKER" "$f"; then
    echo "$f: already has the DOCKER-USER block, skipping"
    continue
  fi
  if $APPLY; then
    cp -p "$f" "$f.pre-sgnl"
    { echo; block; } >> "$f"
  else
    echo "would append to $f:"; block | sed 's/^/  /'
  fi
done

run ufw reload
if $APPLY; then
  iptables -S DOCKER-USER
  ip6tables -S DOCKER-USER
  echo "Now check from OUTSIDE the box: nmap -Pn -p 1-65535 <this server's public IP>"
  echo "and that the other apps on this host still load."
fi
