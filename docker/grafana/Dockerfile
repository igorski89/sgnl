# Grafana with SGNL's provisioning and dashboards baked in
# (config/deploy.monitoring.yml). Exact tags, verified on 2026-10-24; bump
# deliberately, never `latest`. A co-tenant app's dashboards are bind-mounted
# at /var/lib/grafana-dashboards/$SGNL_COTENANT at run time (not part of
# the image; provisioning/dashboards/dashboards.yml).
# The Logs org's datasources and dashboard (logs-org/) are not in the
# image either: bin/sgnl-grafana-setup applies them through the API.
FROM grafana/grafana:13.2.4
# Plugins outside /var/lib/grafana: that is the data volume, which would
# hide what the image installs there.
ENV GF_PATHS_PLUGINS=/var/lib/grafana-plugins
# Overridden by the deploy env when there is a co-tenant app.
ENV SGNL_COTENANT=none
USER root
RUN install -d -o grafana -g root /var/lib/grafana-plugins
USER grafana
RUN grafana cli --pluginsDir /var/lib/grafana-plugins plugins install victoriametrics-logs-datasource 0.32.0
COPY provisioning /etc/grafana/provisioning
COPY dashboards /var/lib/grafana-dashboards/sgnl
