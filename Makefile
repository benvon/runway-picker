.PHONY: install validate security ci ci-e2e

install:
	npm ci

validate:
	npm run typecheck
	npm run lint
	npm run test:coverage
	npm run build

security:
	npm run security:secrets
	npm run lint:workflows
	npm run security:audit

ci: install validate security
ifeq ($(strip $(PREVIEW_URL)),)
	@echo "Skipping E2E because PREVIEW_URL is not set."
else
	$(MAKE) ci-e2e
endif

ci-e2e:
	npm run test:e2e
