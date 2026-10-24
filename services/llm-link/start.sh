# The language model is not an EiN service — ours is a container of its own, a provider's is
# elsewhere — but `health` and the dashboard read service rows, and the assistant has no other. This
# service is that row: its checkCommand tells `health` whether the model answers, where it runs and
# whether it has been tried with the assistant's prompts, and the loop below logs every change in
# that, so "the llm went away at 03:12", or "went to the CPU", is in a service log.
echo llm-link: watching "${CFG_LLM_PROVIDER:-ours}" at "${CFG_LLM_URL:-http://127.0.0.1:8190}"

last=""
while true; do
  now=$(JSON_OUTPUT=0 llm-status --brief 2>/dev/null)
  if [ "$now" != "$last" ]; then
    echo "llm-link: $now"
    last=$now
  fi
  sleep 60
done
