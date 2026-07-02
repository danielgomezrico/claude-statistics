.PHONY: run stop

# Serve over HTTP (not file://) to avoid CORS blocks on module scripts,
# web workers, and cross-file loads in modern browsers.
run:
	@python3 -m http.server 8765 >/dev/null 2>&1 & SERVER_PID=$$!; \
	sleep 0.8; \
	open "http://localhost:8765/"; \
	echo "Serving at http://localhost:8765/ (pid $$SERVER_PID). Use 'make stop' to kill later."; \
	wait $$SERVER_PID 2>/dev/null || true

stop:
	@pkill -f 'python3 -m http.server 8765' 2>/dev/null || pkill -f 'http.server 8765' || true
	@echo "Stopped local server."
