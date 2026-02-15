// RenRen Proxy URL Codec

export class RenRenCodec {
  constructor(config = {}) {
    this.method = config.method || 'xor';
    this.salt = config.salt || 'renren-salt-2026';
  }

  encode(url) {
    switch (this.method) {
      case 'xor':
        return this.xorEncode(url);
      case 'base64':
        return btoa(url);
      case 'plain':
        return url;
      default:
        return btoa(url);
    }
  }

  decode(encoded) {
    try {
      switch (this.method) {
        case 'xor':
          return this.xorDecode(encoded);
        case 'base64':
          return atob(encoded);
        case 'plain':
          return encoded;
        default:
          return atob(encoded);
      }
    } catch (error) {
      console.error('Decode error:', error);
      return null;
    }
  }

  xorEncode(str) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
      result += String.fromCharCode(
        str.charCodeAt(i) ^ this.salt.charCodeAt(i % this.salt.length)
      );
    }
    return btoa(result);
  }

  xorDecode(encoded) {
    const decoded = atob(encoded);
    let result = '';
    for (let i = 0; i < decoded.length; i++) {
      result += String.fromCharCode(
        decoded.charCodeAt(i) ^ this.salt.charCodeAt(i % this.salt.length)
      );
    }
    return result;
  }
}

// グローバルに公開
if (typeof window !== 'undefined') {
  window.RenRenCodec = RenRenCodec;
}
