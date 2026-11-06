import 'package:flutter/material.dart';
import 'package:property_token_app/app/app.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/core/network/dpop.dart';
import 'package:property_token_app/core/push/firebase_push.dart';
import 'package:property_token_app/core/push/push_registrar.dart';
import 'package:property_token_app/core/storage/token_store.dart';
import 'package:property_token_app/features/account/data/account_repository_impl.dart';
import 'package:property_token_app/features/auth/data/auth_repository_impl.dart';
import 'package:property_token_app/features/inbox/data/inbox_repository_impl.dart';
import 'package:property_token_app/features/invest/data/invest_repository_impl.dart';
import 'package:property_token_app/features/market/data/market_repository_impl.dart';
import 'package:property_token_app/features/offerings/data/offerings_repository_impl.dart';
import 'package:property_token_app/features/portfolio/data/portfolio_repository_impl.dart';
import 'package:property_token_app/features/rent/data/rent_repository_impl.dart';

/// The API base URL comes from the build: `--dart-define=API_BASE_URL=https://.../v1`.
/// The default is the demo server (plain HTTP, demo only: production needs TLS, ADR 0018).
const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://51.79.144.40/v1');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final tokens = SecureTokenStore();
  // Tokens bound to this phone's key (DPoP, RFC 9449, ADR 0018 amendment 7).
  final api = ApiClient(baseUrl: Uri.parse(apiBaseUrl), tokens: tokens, dpop: EcDpopSigner(SecureDpopKeyStore()));
  // Notices to this phone (ADR 0018 amendment 6); off when the build has no Firebase options.
  final pushSource = await FirebasePushTokenSource.start();
  final push = pushSource == null ? null : PushRegistrar(api, pushSource);
  runApp(
    PropertyTokenApp(
      repositories: AppRepositories(
        auth: AuthRepositoryImpl(api, tokens, push),
        offerings: OfferingsRepositoryImpl(api),
        portfolio: PortfolioRepositoryImpl(api),
        inbox: InboxRepositoryImpl(api),
        account: AccountRepositoryImpl(api),
        rent: RentRepositoryImpl(api),
        market: MarketRepositoryImpl(api),
        invest: InvestRepositoryImpl(api),
        api: api,
      ),
    ),
  );
}
