export type LogLine = {
  ts: number
  stream: "stdout" | "stderr"
  text: string
}

export type RingBuffer = {
  push(line: LogLine): void
  snapshot(): LogLine[]
  size(): number
}

export function createRingBuffer(cap: number): RingBuffer {
  const items: LogLine[] = []
  return {
    push(line) {
      items.push(line)
      if (items.length > cap) items.splice(0, items.length - cap)
    },
    snapshot() {
      return items.slice()
    },
    size() {
      return items.length
    },
  }
}

// Line-framing for child stdio chunks. Node streams deliver arbitrary-sized
// buffers; our log UI wants discrete lines. Anything left after the last
// newline stays in the internal buffer until the next chunk (or flush).
export function createLineFramer(emit: (text: string) => void): {
  push(chunk: string): void
  flush(): void
} {
  let tail = ""
  return {
    push(chunk) {
      tail += chunk
      let idx: number
      while ((idx = tail.indexOf("\n")) !== -1) {
        const line = tail.slice(0, idx)
        tail = tail.slice(idx + 1)
        emit(line.replace(/\r$/, ""))
      }
    },
    flush() {
      if (tail.length > 0) {
        emit(tail)
        tail = ""
      }
    },
  }
}
