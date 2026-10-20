# Azure Foundry

In **Settings → AI & Models → Azure Foundry**, enter:

- Your resource endpoint, such as `https://your-resource.services.ai.azure.com` or `https://your-resource.openai.azure.com`. The `/openai/v1` suffix is added automatically.
- The **deployment name** you created in Azure, which may differ from the underlying model name.
- Your resource API key.

Choose **CHECK & USE**. This makes one small inference request using your Azure quota, validates the deployment, saves the connection through StarNet's existing credential storage, and selects it as the station provider. A rejected check leaves your saved connection and selection unchanged. API keys stay on the inference host; requests do not go through OpenRouter or OpenAI's public endpoint.

This connector uses Azure's OpenAI v1 Chat Completions API, including streamed answers and function tools when supported by the deployment. Project URLs, legacy deployment URLs with `api-version`, Entra ID authentication, Anthropic-native deployments, and the Responses API are not supported by this connector. Azure pricing is not guessed from public OpenAI prices; costs remain unpriced unless the endpoint provides pricing.

Azure's model catalog can contain base model IDs rather than your deployment names. StarNet preserves your explicit deployment instead of replacing it from that catalog. Background health checks do not generate text or verify deployment access; use **CHECK & USE** for that check. Reopen the Azure card to change the endpoint or deployment. Re-enter the resource API key on each check. Remove any spare Azure keys before switching resources, because those keys belong to the previous resource.

For operator-managed setup, the sidecar also reads `AZURE_OPENAI_API_KEY` / `AZURE_AI_API_KEY` and `AZURE_OPENAI_ENDPOINT` / `AZURE_AI_ENDPOINT`. Each agent or station model selection must still name the actual Azure deployment.

Reference: [Microsoft Foundry v1 API lifecycle](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle).
