package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

// ──────────────────────────────────────────────
// TLS Sidecar — Go uTLS reverse proxy
//
// Node.js 发请求到 http://127.0.0.1:<port>，
// 通过以下自定义 Header 传递目标信息：
// X-Target-Url: 实际目标 URL（必填）
// X-Proxy-Url: 上游代理（可选，支持 http/socks5）
//
// 所有其他 Header 原样转发给目标服务器。
// 响应（包括 SSE 流式）透传回 Node.js。
//
// uTLS 使用 Chrome 最新指纹，ALPN 协商 h2/http1.1，
// 根据服务器返回的 ALPN 自动选择 HTTP/2 或 HTTP/1.1 传输。
// ──────────────────────────────────────────────

const (
	defaultPort      = 9091
	headerTarget     = "X-Target-Url"
	headerProxy      = "X-Proxy-Url"
	readTimeout      = 30 * time.Second
	writeTimeout     = 0 // SSE 流式响应不设写超时（仅监听 localhost，安全）
	idleTimeout      = 120 * time.Second
)

// 全局 RoundTripper 缓存（按 proxyURL 分组，复用 H2 连接）
var (
	rtCacheMu sync.Mutex
	rtCache   = make(map[string]*utlsRoundTripper)
)

func getOrCreateRT(proxyURL string) *utlsRoundTripper {
	rtCacheMu.Lock()
	defer rtCacheMu.Unlock()
	if rt, ok := rtCache[proxyURL]; ok {
		return rt
	}
	rt := newUTLSRoundTripper(proxyURL)
	rtCache[proxyURL] = rt
	return rt
}

// ──────────────── TLS 指纹选择 ────────────────

func getClientHelloID(name string) utls.ClientHelloID {
	switch strings.ToLower(name) {
	case "chrome_120":
		return utls.HelloChrome_120
	case "chrome_120_pq":
		return utls.HelloChrome_120_PQ
	case "firefox":
		return utls.HelloFirefox_Auto
	case "edge":
		return utls.HelloEdge_Auto
	default:
		return utls.HelloChrome_Auto
	}
}

// ──────────────── uTLS RoundTripper ────────────────
// 根据 ALPN 协商结果自动选择 H2 或 H1 传输

type utlsRoundTripper struct {
	proxyURL string
	mu       sync.Mutex
	h2Conns  map[string]*http2.ClientConn // H2 连接缓存 (per host + fingerprint)
}

func newUTLSRoundTripper(proxyURL string) *utlsRoundTripper {
	return &utlsRoundTripper{
		proxyURL: proxyURL,
		h2Conns:  make(map[string]*http2.ClientConn),
	}
}

func (rt *utlsRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	// 读取并移除 X-Tls-Fingerprint 头（不转发给目标）
	fingerprintName := ""
	if f := req.Header.Get("X-Tls-Fingerprint"); f != "" {
		fingerprintName = f
		req.Header.Del("X-Tls-Fingerprint")
	}
	clientHelloID := getClientHelloID(fingerprintName)

	addr := req.URL.Host
	if !strings.Contains(addr, ":") {
		if req.URL.Scheme == "https" {
			addr += ":443"
		} else {
			addr += ":80"
		}
	}

	// 尝试复用已有的 H2 连接（按 host+指纹 缓存）
	h2Key := addr + "|" + fingerprintName
	rt.mu.Lock()
	if cc, ok := rt.h2Conns[h2Key]; ok {
		rt.mu.Unlock()
		if cc.CanTakeNewRequest() {
			resp, err := cc.RoundTrip(req)
			if err == nil {
				return resp, nil
			}
			// H2 连接已失效，清除缓存重建
			cc.Close()
			rt.mu.Lock()
			delete(rt.h2Conns, h2Key)
			rt.mu.Unlock()
		}
	} else {
		rt.mu.Unlock()
	}

	// 用 uTLS 建立 TLS 连接，自动指纹
	utlsCfg := &utls.Config{
		ServerName: req.URL.Hostname(),
	}

	// 处理代理
	var dialConn net.Conn
	var err error
	if rt.proxyURL != "" {
		pu, errParse := url.Parse(rt.proxyURL)
		if errParse == nil {
			dialer, err := proxy.FromURL(pu, proxy.Direct)
			if err == nil {
				dialConn, err = dialer.Dial("tcp", addr)
			}
			if err != nil {
				log.Printf("[TLS-Sidecar] 代理连接失败 %s: %v", rt.proxyURL, err)
			}
		}
	}
	if dialConn == nil {
		dialer := &net.Dialer{
			Timeout:   readTimeout,
			KeepAlive: 30 * time.Second,
		}
		dialConn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return nil, err
	}

	// 完成 TLS 握手
	uConn := utls.UClient(dialConn, utlsCfg, clientHelloID)
	if err = uConn.Handshake(); err != nil {
		dialConn.Close()
		return nil, err
	}

	// 根据 ALPN 选择协议
	selectedProto := uConn.ConnectionState().NegotiatedProtocol
	var resp *http.Response
	if selectedProto == http2.NextProtoTLS {
		// HTTP/2
		t := &http2.Transport{
			DialTLS: func(network, addr string, cfg *tls.Config) (net.Conn, error) {
				return uConn, nil
			},
			IdleConnTimeout: idleTimeout,
		}
		// 连接成功后缓存
		cc, err := t.NewClientConn(uConn)
		if err != nil {
			uConn.Close()
			return nil, err
		}
		rt.mu.Lock()
		rt.h2Conns[h2Key] = cc
		rt.mu.Unlock()
		resp, err = cc.RoundTrip(req)
	} else {
		// HTTP/1.1
		transport := &http.Transport{
			DialTLS: func(network, addr string) (net.Conn, error) {
				return uConn, nil
			},
			IdleConnTimeout: idleTimeout,
		}
		client := &http.Client{Transport: transport}
		resp, err = client.Do(req)
	}

	return resp, err
}

// ──────────────────────────────────────────────
// 请求处理: proxyHandler 从 X-Target-Url 提取目标，
// 然后通过 uTLS 发起请求，将响应原样返回。
// ──────────────────────────────────────────────

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	targetURLStr := r.Header.Get(headerTarget)
	if targetURLStr == "" {
		http.Error(w, fmt.Sprintf("missing %s header", headerTarget), http.StatusBadRequest)
		return
	}

	proxyURLStr := r.Header.Get(headerProxy) // 可选

	// 解析目标 URL
	targetURL, err := url.Parse(targetURLStr)
	if err != nil {
		http.Error(w, fmt.Sprintf("invalid %s: %v", headerTarget, err), http.StatusBadRequest)
		return
	}

	// 构建新请求
	req, err := http.NewRequest(r.Method, targetURLStr, r.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf("build request failed: %v", err), http.StatusInternalServerError)
		return
	}

	// 复制所有 Header（除了我们自己的特殊 Header）
	for k, v := range r.Header {
		if strings.EqualFold(k, headerTarget) || strings.EqualFold(k, headerProxy) {
			continue
		}
		req.Header[k] = v
	}

	// 设置正确的 Host
	req.Host = targetURL.Host
	if targetURL.Port() != "" && !strings.Contains(req.Host, ":") {
		req.Host += ":" + targetURL.Port()
	}

	// 获取 uTLS RoundTripper
	rt := getOrCreateRT(proxyURLStr)

	// 发送请求
	resp, err := rt.RoundTrip(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("upstream request failed: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// 复制所有响应头给客户端
	for k, v := range resp.Header {
		w.Header()[k] = v
	}

	// 设置状态码
	w.WriteHeader(resp.StatusCode)

	// 流式复制响应体（支持 SSE）
	// 不缓存，直接 flush，让客户端立即收到
	flusher, ok := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			_, writeErr := w.Write(buf[:n])
			if writeErr != nil {
				break
			}
			if ok {
				flusher.Flush()
			}
		}
		if err != nil {
			if err != io.EOF {
				log.Printf("[TLS-Sidecar] read error from %s: %v", targetURLStr, err)
			}
			break
		}
	}
}

func main() {
	port := defaultPort
	if portEnv := os.Getenv("PORT"); portEnv != "" {
		if p, err := strconv.Atoi(portEnv); err == nil && p > 0 && p < 65536 {
			port = p
		}
	}

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	server := &http.Server{
		Addr:         addr,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
		IdleTimeout:  idleTimeout,
	}

	http.HandleFunc("/", proxyHandler)

	log.Printf("[TLS-Sidecar] starting TLS fingerprint proxy on %s", addr)
	log.Printf("[TLS-Sidecar] usage: send request with %s header to target URL", headerTarget)
	log.Printf("[TLS-Sidecar] (optional) add %s header to use upstream proxy", headerProxy)

	// 处理优雅关闭
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		log.Println("[TLS-Sidecar] shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Fatalf("[TLS-Sidecar] shutdown error: %v", err)
		}
		log.Println("[TLS-Sidecar] shutdown complete")
		os.Exit(0)
	}()

	err := server.ListenAndServe()
	if err != nil && err != http.ErrServerClosed {
		log.Fatalf("[TLS-Sidecar] listen and serve failed: %v", err)
	}
}
