import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:pointycastle/export.dart';

/// DPoP proofs, RFC 9449 (ADR 0018 amendment 7): the app's P-256 key signs a
/// short JWT for every token request and API call, so a copied token is
/// useless without this phone. The private key stays in the keystore
/// ([DpopKeyStore]); the server sees only the public half (jwk).
abstract interface class DpopSigner {
  /// A proof for one request. [accessToken] is given for API calls (ath).
  Future<String> proof({required String method, required Uri url, String? accessToken});
}

/// Where the private key lives (the platform keystore in the app).
abstract interface class DpopKeyStore {
  Future<String?> read();
  Future<void> write(String value);
}

/// ES256 (ECDSA P-256, SHA-256, deterministic nonces RFC 6979).
class EcDpopSigner implements DpopSigner {
  EcDpopSigner(this._store, {DateTime Function()? now, Random? random})
    : _now = now ?? DateTime.now,
      _random = random ?? Random.secure();

  final DpopKeyStore _store;
  final DateTime Function() _now;
  final Random _random;
  static final _curve = ECCurve_secp256r1();
  ECPrivateKey? _key;
  Map<String, String>? _jwk;

  Future<ECPrivateKey> _load() async {
    final cached = _key;
    if (cached != null) return cached;
    final saved = await _store.read();
    BigInt d;
    if (saved != null && RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(saved)) {
      d = _toBigInt(base64Url.decode('$saved='));
    } else {
      // A fresh key: 32 random bytes below the curve order.
      do {
        d = _toBigInt(Uint8List.fromList(List.generate(32, (_) => _random.nextInt(256))));
      } while (d == BigInt.zero || d >= _curve.n);
      await _store.write(_b64(_toBytes(d)));
    }
    final q = (_curve.G * d)!;
    _jwk = {
      'kty': 'EC',
      'crv': 'P-256',
      'x': _b64(_toBytes(q.x!.toBigInteger()!)),
      'y': _b64(_toBytes(q.y!.toBigInteger()!)),
    };
    return _key = ECPrivateKey(d, _curve);
  }

  /// The public key as the server sees it (for tests and diagnostics).
  Future<Map<String, String>> publicJwk() async {
    await _load();
    return Map.unmodifiable(_jwk!);
  }

  @override
  Future<String> proof({required String method, required Uri url, String? accessToken}) async {
    final key = await _load();
    final header = {'typ': 'dpop+jwt', 'alg': 'ES256', 'jwk': _jwk};
    final claims = <String, Object>{
      'jti': _b64(Uint8List.fromList(List.generate(16, (_) => _random.nextInt(256)))),
      'htm': method,
      // The URL without query and fragment (RFC 9449 section 4.2).
      'htu': Uri(scheme: url.scheme, host: url.host, port: url.hasPort ? url.port : null, path: url.path).toString(),
      'iat': _now().millisecondsSinceEpoch ~/ 1000,
      if (accessToken != null)
        'ath': _b64(Uint8List.fromList(SHA256Digest().process(Uint8List.fromList(ascii.encode(accessToken))))),
    };
    final input = '${_b64(utf8.encode(jsonEncode(header)))}.${_b64(utf8.encode(jsonEncode(claims)))}';
    final signer = ECDSASigner(SHA256Digest(), HMac(SHA256Digest(), 64))
      ..init(true, PrivateKeyParameter<ECPrivateKey>(key));
    final sig = signer.generateSignature(Uint8List.fromList(ascii.encode(input))) as ECSignature;
    return '$input.${_b64(Uint8List.fromList([..._toBytes(sig.r), ..._toBytes(sig.s)]))}';
  }

  static String _b64(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

  static BigInt _toBigInt(List<int> bytes) => bytes.fold(BigInt.zero, (v, b) => (v << 8) | BigInt.from(b));

  /// Big-endian, exactly 32 bytes.
  static Uint8List _toBytes(BigInt v) {
    final out = Uint8List(32);
    var x = v;
    for (var i = 31; i >= 0; i--) {
      out[i] = (x & BigInt.from(0xff)).toInt();
      x = x >> 8;
    }
    return out;
  }
}

/// The key in the platform keystore (Android Keystore, iOS Keychain), next to the tokens.
class SecureDpopKeyStore implements DpopKeyStore {
  SecureDpopKeyStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'pt.dpop.p256.v1';
  final FlutterSecureStorage _storage;

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String value) => _storage.write(key: _key, value: value);
}

/// For tests.
class MemoryDpopKeyStore implements DpopKeyStore {
  String? _value;

  @override
  Future<String?> read() async => _value;

  @override
  Future<void> write(String value) async => _value = value;
}
