import 'package:flutter/material.dart';
import 'package:property_token_app/app/app.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/core/storage/token_store.dart';
import 'package:property_token_app/features/account/data/account_repository_impl.dart';
import 'package:property_token_app/features/auth/data/auth_repository_impl.dart';
import 'package:property_token_app/features/inbox/data/inbox_repository_impl.dart';
import 'package:property_token_app/features/offerings/data/offerings_repository_impl.dart';
import 'package:property_token_app/features/portfolio/data/portfolio_repository_impl.dart';

/// The API base URL comes from the build: `--dart-define=API_BASE_URL=https://.../v1`.
/// The default is the demo server (plain HTTP, demo only: production needs TLS, ADR 0018).
const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://51.79.144.40/v1');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final tokens = SecureTokenStore();
  final api = ApiClient(baseUrl: Uri.parse(apiBaseUrl), tokens: tokens);
  runApp(
    PropertyTokenApp(
      repositories: AppRepositories(
        auth: AuthRepositoryImpl(api, tokens),
        offerings: OfferingsRepositoryImpl(api),
        portfolio: PortfolioRepositoryImpl(api),
        inbox: InboxRepositoryImpl(api),
        account: AccountRepositoryImpl(api),
        api: api,
      ),
    ),
  );
}
