/**
 * test-qwen-long-context-bench.js
 *
 * Benchmarks JSON body parsing/stringifying performance at different
 * context sizes to understand the overhead of large request bodies.
 */

function generateFillText(targetBytes) {
    const filler = '人工智能技术正在深刻改变着人类社会的方方面面。从医疗健康到交通运输，从教育培训到金融服务，AI的应用无处不在。'
    return filler.repeat(Math.ceil(targetBytes / Buffer.byteLength(filler))).slice(0, targetBytes)
}

function buildTestBody(contextBytes) {
    const fillText = generateFillText(contextBytes)
    return {
        model: 'qwen3.8-max-preview',
        stream: true,
        messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: fillText }
        ]
    }
}

async function runBenchmarks() {
    const sizes = ['1K', '32K', '128K', '256K', '500K']
    const sizeMap = { '1K': 1024, '32K': 32768, '128K': 131072, '256K': 262144, '500K': 512000 }

    console.log('Qwen Long Context Benchmarks')
    console.log('=============================\n')

    console.log('Context Size | Body Size | Stringify (ms) | Parse (ms) | Total (ms)')
    console.log('-'.repeat(70))

    for (const label of sizes) {
        const bytes = sizeMap[label]
        const body = buildTestBody(bytes)

        const t0 = performance.now()
        const json = JSON.stringify(body)
        const t1 = performance.now()
        const parsed = JSON.parse(json)
        const t2 = performance.now()

        const stringifyMs = (t1 - t0).toFixed(1)
        const parseMs = (t2 - t1).toFixed(1)
        const totalMs = (t2 - t0).toFixed(1)
        const bodyKB = (json.length / 1024).toFixed(1)

        console.log(`${label.padEnd(12)} | ${bodyKB.padEnd(8)}KB | ${stringifyMs.padEnd(12)} | ${parseMs.padEnd(10)} | ${totalMs}`)
    }

    // Memory usage
    const mem = process.memoryUsage()
    console.log(`\nMemory: RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB, Heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`)
}

runBenchmarks().catch(err => {
    console.error('FATAL:', err)
    process.exitCode = 1
})