import 'package:equatable/equatable.dart';

/// An in-app notification (schema Notification), already rendered by the API in the requested language.
class Message extends Equatable {
  const Message({
    required this.id,
    required this.title,
    required this.body,
    required this.createdAt,
    required this.read,
  });

  factory Message.fromJson(Map<String, dynamic> j) => Message(
    id: j['id'] as String,
    title: j['title'] as String,
    body: j['body'] as String,
    createdAt: DateTime.parse(j['created_at'] as String),
    read: j['read'] as bool,
  );

  final String id;
  final String title;
  final String body;
  final DateTime createdAt;
  final bool read;

  @override
  List<Object?> get props => [id, read];
}

class MessagePage extends Equatable {
  const MessagePage(this.items, this.nextCursor);

  final List<Message> items;
  final String? nextCursor;

  @override
  List<Object?> get props => [items, nextCursor];
}

abstract interface class InboxRepository {
  Future<MessagePage> page({String? cursor});
}
