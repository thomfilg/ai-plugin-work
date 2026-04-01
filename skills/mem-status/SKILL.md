---
name: mem-status
description: Show current memory usage and Claude process information
user-invocable: true
allowed-tools: Bash, Read
---
# Memory Status Command

Show current memory usage and Claude process information.

## Instructions

Run the following commands to display memory status:

```bash
echo "=== Memory Status ===" && \
cat /proc/meminfo | grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):" | \
awk '{
  name=$1; gsub(":", "", name);
  kb=$2;
  gb=kb/1024/1024;
  printf "%-15s %8.2f GB\n", name, gb
}' && \
echo "" && \
echo "=== Memory Usage ===" && \
free -h && \
echo "" && \
echo "=== Claude Processes ===" && \
ps aux --sort=-%mem | grep -E "(claude|anthropic)" | grep -v grep | \
awk '{printf "PID: %-6s MEM: %-5s CPU: %-5s CMD: %s\n", $2, $4"%", $3"%", substr($0, index($0,$11), 60)}' | head -10 && \
echo "" && \
echo "=== Top Memory Consumers ===" && \
ps aux --sort=-%mem | head -11 | tail -10 | \
awk '{printf "PID: %-6s MEM: %-5s CMD: %.40s\n", $2, $4"%", $11}' && \
echo "" && \
echo "=== Container Memory Limit ===" && \
if [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo "0")
  usage=$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || echo "0")
  if [ "$limit" != "0" ] && [ "$limit" != "9223372036854771712" ]; then
    echo "Limit: $(echo "scale=2; $limit/1024/1024/1024" | bc) GB"
    echo "Usage: $(echo "scale=2; $usage/1024/1024/1024" | bc) GB"
  else
    echo "No container memory limit detected"
  fi
elif [ -f /sys/fs/cgroup/memory.max ]; then
  limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "max")
  usage=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || echo "0")
  if [ "$limit" != "max" ]; then
    echo "Limit: $(echo "scale=2; $limit/1024/1024/1024" | bc) GB"
    echo "Usage: $(echo "scale=2; $usage/1024/1024/1024" | bc) GB"
  else
    echo "No container memory limit detected"
  fi
else
  echo "Cgroup memory info not available"
fi
```

## Summary Format

After running the commands, provide a brief summary:

1. **Total/Available Memory**: X GB total, Y GB available (Z% used)
2. **Swap Status**: Configured/Not configured, X GB used
3. **Claude Instances**: Count and their memory usage
4. **Top Consumers**: List the top 3 memory-consuming processes
5. **Recommendation**: Based on current usage, suggest if WSL restart is needed
