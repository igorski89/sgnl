#!/usr/bin/env bash
# Runs ON a dev VM as root (bin/sgnl-dev): what the dev VM needs that prod
# gets from the internet. Idempotent.
#   1. Names: dnsmasq on the Docker bridge answers <domain> and all its
#      subdomains with the host, so containers reach kamal-proxy by name;
#      everything else goes to the VM's normal resolver. Docker uses it.
#   2. Trust: the dev CA (stdin) in the VM's store and at
#      /opt/sgnl/dev-ca/ca.pem for containers to mount.
#   3. Isolation: no mail leaves the VM. Outgoing SMTP (25, 465, 587) to
#      anything outside the VM and its containers is rejected and logged,
#      for the VM itself and for every container (DOCKER-USER chain).
#   usage: vm-prep.sh <domain> < rootCA.pem
set -euo pipefail
domain=$1
GW=172.17.0.1

install -d -m 755 /opt/sgnl/dev-ca
cat > /opt/sgnl/dev-ca/ca.pem
chmod 644 /opt/sgnl/dev-ca/ca.pem
cp /opt/sgnl/dev-ca/ca.pem /usr/local/share/ca-certificates/sgnl-dev-ca.crt
update-ca-certificates >/dev/null

command -v dnsmasq >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsmasq >/dev/null
# The VM's own upstream (Lima's), never dnsmasq itself (a loop).
upstream=$(awk '/^nameserver/{print $2}' /run/systemd/resolve/resolv.conf | grep -vx "$GW" | head -1)
cat > /etc/dnsmasq.d/sgnl-dev.conf <<CONF
# bin/sgnl-dev: names of the dev instance -> this VM (kamal-proxy on 443).
listen-address=$GW
bind-interfaces
no-resolv
server=$upstream
address=/$domain/$GW
CONF
# Ubuntu's dnsmasq would also want port 53 on all addresses; ours only $GW.
sed -i 's/^#\?DNSMASQ_EXCEPT=.*/DNSMASQ_EXCEPT="lo"/' /etc/default/dnsmasq 2>/dev/null || true
mkdir -p /etc/systemd/system/dnsmasq.service.d
cat > /etc/systemd/system/dnsmasq.service.d/after-docker.conf <<UNIT
[Unit]
After=docker.service
Requires=docker.service
UNIT
systemctl daemon-reload
# The VM's own tools resolve the dev names through dnsmasq too.
mkdir -p /etc/systemd/resolved.conf.d
cat > /etc/systemd/resolved.conf.d/sgnl-dev.conf <<CONF
[Resolve]
DNS=$GW
Domains=~$domain
CONF

python3 - <<PY
import json, os
p = "/etc/docker/daemon.json"
d = json.load(open(p)) if os.path.exists(p) else {}
d["dns"] = ["$GW"]
json.dump(d, open(p, "w"), indent=2)
PY
systemctl restart docker
systemctl enable --now dnsmasq >/dev/null 2>&1
systemctl restart dnsmasq systemd-resolved

# No mail out (iptables-nft, like Docker's own rules).
cat > /usr/local/sbin/sgnl-dev-egress <<'FW'
#!/bin/sh
# bin/sgnl-dev: reject outgoing SMTP except inside the VM.
for chain in OUTPUT DOCKER-USER; do
  iptables -N SGNL-NOMAIL 2>/dev/null || true
  iptables -C $chain -j SGNL-NOMAIL 2>/dev/null || iptables -I $chain 1 -j SGNL-NOMAIL
done
iptables -F SGNL-NOMAIL
for net in 127.0.0.0/8 172.16.0.0/12 10.0.0.0/8; do iptables -A SGNL-NOMAIL -d $net -j RETURN; done
iptables -A SGNL-NOMAIL -p tcp -m multiport --dports 25,465,587,2525 -j LOG --log-prefix "sgnl-dev-nomail: "
iptables -A SGNL-NOMAIL -p tcp -m multiport --dports 25,465,587,2525 -j REJECT
FW
chmod 755 /usr/local/sbin/sgnl-dev-egress
cat > /etc/systemd/system/sgnl-dev-egress.service <<'UNIT'
[Unit]
Description=SGNL dev: no outgoing mail
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sgnl-dev-egress
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now sgnl-dev-egress >/dev/null 2>&1
systemctl restart sgnl-dev-egress
echo "vm-prep: ok ($domain -> $GW, CA trusted, outgoing SMTP blocked)"
