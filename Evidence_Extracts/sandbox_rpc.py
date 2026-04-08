"""Calls RPCs out of XBox.

This module allows for clients to send messages to / from external services from
inside XBox.
"""

import dataclasses
import io
import json
import os
import socket
import sys
import threading
from typing import Any, Union

from . import sandbox_rpc_pb2
from .tool_use import metaprogramming
from .tool_use import runtime
from .tool_use import tool_operation_error


_io_lock = threading.Lock()
_pipe_reader: io.BufferedReader | None = None
_pipe_writer: io.BufferedWriter | None = None


def _get_pipe_reader_and_writer() -> (
    tuple[io.BufferedReader, io.BufferedWriter]
):
  """Returns the reader and writer handles for pipe rpc.

  Uses /dev/fd/3 and /dev/fd/4 as the pipe handles for writing and reading
  respectively.

  Returns:
    A tuple of (reader, writer) handles for pipe rpc.
  Raises:
    RuntimeError: If _io_lock is not locked.
  """
  if not _io_lock.locked():
    raise RuntimeError(
        "Must acquire _io_lock before calling _get_pipe_reader_and_writer()"
    )
  global _pipe_reader
  global _pipe_writer
  if _pipe_writer is None:
    _pipe_writer = os.fdopen(4, "wb", closefd=False)
  if _pipe_reader is None:
    _pipe_reader = os.fdopen(3, "rb", closefd=False)
  return (_pipe_reader, _pipe_writer)


def _make_rpc_with_sockets(
    request: sandbox_rpc_pb2.RpcRequest, ip_address: str
) -> sandbox_rpc_pb2.RpcResponse:
  """Sends an RPC out of the sandbox via sockets.

  Socket connection is not kept alive, it's created and closed for each RPC.
  This is different from the pipe implementation where the pipe handles are
  reused.

  Args:
    request: The request to send to the server.
    ip_address: The IP address of the server.

  Returns:
    The response from the server.
  """
  host, port_str = ip_address.split(":")
  port = int(port_str)
  s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
  s.connect((host, port))
  writer = io.BufferedWriter(s.makefile("wb", buffering=0))
  reader = io.BufferedReader(s.makefile("rb", buffering=0))

  serialized_request = request.SerializeToString()
  writer.write(serialized_request)
  writer.flush()
  s.shutdown(socket.SHUT_WR)
  response = sandbox_rpc_pb2.RpcResponse.FromString(reader.read())
  s.close()
  return response


def _make_rpc_with_pipes(
    request: sandbox_rpc_pb2.RpcRequest,
) -> sandbox_rpc_pb2.RpcResponse | None:
  """Sends an RPC out of the sandbox via pipes."""
  with _io_lock:
    try:
      reader, writer = _get_pipe_reader_and_writer()
    except OSError as err:
      sys.stderr.write("Unable to open reader / writer! Error: " + str(err))
      return None

    serialized_request = request.SerializeToString()
    # First write the size of the message
    writer.write(len(serialized_request).to_bytes(4, sys.byteorder))

    # Then the message itself
    writer.write(serialized_request)

    # Flush to actually send it
    writer.flush()

    # To get a response, read the size of the message first (this will block
    # on a message being available)
    response_size = int.from_bytes(reader.read(4), sys.byteorder)

    # Then read the following protobuffer, assume it is the size indicated
    return sandbox_rpc_pb2.RpcResponse.FromString(reader.read(response_size))


def set_fifos(
    reader_path: str = "", writer_path: str = ""
) -> None:
  """Sets the reader and writer handles for pipe rpc from paths."""

  reader = open(reader_path, "rb") if reader_path else None
  writer = open(writer_path, "wb") if writer_path else None
  set_reader_and_writer(reader, writer)


def set_reader_and_writer(
    reader: io.BufferedReader | None,
    writer: io.BufferedWriter | None,
) -> None:
  """Sets the reader and writer handles for pipe rpc."""
  with _io_lock:
    global _pipe_reader
    global _pipe_writer
    _pipe_reader, _pipe_writer = reader, writer


def make_rpc(
    request: sandbox_rpc_pb2.RpcRequest,
) -> sandbox_rpc_pb2.RpcResponse | None:
  """Sends an RPC out of the sandbox.

  Args:
    request: request to forward out of the sandbox

  Returns:
    string, response from the external world
  """
  ip_address = os.environ.get("RPC_TOOL_STREAMING_IP_ADDRESS")
  if ip_address:
    return _make_rpc_with_sockets(request, ip_address)
  else:
    return _make_rpc_with_pipes(request)


def run_tool(
    name: str, operation_id: str, parameters: str
) -> sandbox_rpc_pb2.RunToolResponse:
  """Runs a tool with the given name and id, passing in parameters.

  Args:
    name: The name of the tool.
    operation_id: The name of the operation to perform.
    parameters: The parameters to pass to the tool.

  Returns:
    A RunToolResponse containing the response from the tool.
  """
  result = make_rpc(
      sandbox_rpc_pb2.RpcRequest(
          run_tool_request=sandbox_rpc_pb2.RunToolRequest(
              name=name, operation_id=operation_id, parameters=parameters
          )
      )
  )

  if result and result.HasField("run_tool_response"):
    return result.run_tool_response
  else:
    return sandbox_rpc_pb2.RunToolResponse(response="")


# DEPRECATED
def run_tool_agent(
    name: str, operation_id: str, tool_instruction: str
) -> sandbox_rpc_pb2.RunToolResponse:
  """Runs a tool agent with the given name and id, passing in tool_instruction.

  Args:
    name: The name of the tool.
    operation_id: The name of the operation to perform.
    tool_instruction: The natural language instructions to pass to the tool.

  Returns:
    A string that contains the response from the tool.
  """
  result = make_rpc(
      sandbox_rpc_pb2.RpcRequest(
          run_tool_agent_request=sandbox_rpc_pb2.ToolAgentInput(
              tool_name=name,
              operation_id=operation_id,
              tool_instruction=tool_instruction,
          )
      )
  )

  if result and result.HasField("run_tool_response"):
    return result.run_tool_response
  else:
    return sandbox_rpc_pb2.RunToolResponse(response="")


def parse_tool_response(
    tool_name: str,
    response: Union[sandbox_rpc_pb2.RunToolResponse, str],
    return_type: type[Any],
    scope: dict[str, Any],
    strict: bool = False,
    ignore_unrecognized_fields: bool = False,
    model_invisible_fields: Union[list[str], None] = None,
    use_concise_error: bool = False,
) -> Any:
  """Parse the tool response from a string to expected return type in Python.

  Args:
    tool_name: The name of the tool.
    response: The tool response, should be JSON.
    return_type: The Python type to parse the tool response as.
    scope: The scope to resolve types in.
    strict: Whether errors in parsing the result should result in an error
    ignore_unrecognized_fields: Whether unrecognized fields in the tool response
      should be ignored.
    model_invisible_fields: Response fields which should be hidden from model.
    use_concise_error: if True, will only use the RunToolResponse
      status.status_message string as error message.

  Returns:
    An instance of the return_type constructed using the result
    of the tool. If response is not decodable as JSON, raises a
    JSONDecodeError. If the JSON is not decodable as the passed in type,
    then returns a named tuple that corresponds to the JSON if strict is
    false, otherwise raises an error.
  """
  # It would feel more natural for this guard to say
  # `if isinstance(response, sandbox_rpc_pb2.RunToolResponse)`, but that
  # can behave erratically since the python runtime of xbox sometimes uses
  # relative imports.
  if not isinstance(response, str):
    if response.status.code > 1:
      raise ValueError(
          response.status.status_message
          if use_concise_error
          else f"Tool execution encountered an error: {response.status}"
      )
    response = response.response
  try:
    response_json = runtime.decode_json(response, return_type | str)
  except json.decoder.JSONDecodeError as decode_err:
    raise json.decoder.JSONDecodeError(
        f"Response output not parseable: {response}",
        decode_err.doc,
        decode_err.pos,
    )

  try:
    return runtime.parse_response(
        response_json,
        return_type,
        scope,
        top_level=True,
        ignore_unrecognized_fields=ignore_unrecognized_fields,
        model_invisible_fields=model_invisible_fields,
    )
  except runtime.FailedParseError:
    if strict:
      raise
    # There is no enforcement for schema-conformance in Bard Tool Manager.
    return metaprogramming.json_to_namedtuple(response_json, tool_name)


class DataclassJSONEncoder(json.JSONEncoder):
  """JSON encoder that encodes data classes in JSON format."""

  def default(self, o):
    try:
      return o.to_json_serializable()
    except AttributeError:
      pass
    if dataclasses.is_dataclass(o):
      return dataclasses.asdict(o)
    return super().default(o)


def run_tool_parse_result(
    name: str,
    operation_id: str,
    parameters: dict[str, Any],
    return_type: type[Any],
    scope: dict[str, Any],
    strict: bool = False,
    ignore_unrecognized_fields: bool = False,
    model_invisible_fields: Union[list[str], None] = None,
    remove_none_parameters: bool = True,
    use_concise_error: bool = False,
) -> Any:
  """Runs a tool and parses result into a given return type.

  Args:
    name: The name of the tool.
    operation_id: The name of the operation to perform.
    parameters: The parameters to pass to the tool.
    return_type: The Python type to parse the tool response as.
    scope: The scope to resolve types in.
    strict: Whether errors in parsing the result should result in an error
    ignore_unrecognized_fields: Whether unrecognized fields in the tool response
      should be ignored.
    model_invisible_fields: Response fields that should be hidden from model.
    remove_none_parameters: Whether to remove parameters with None value from
      the request.
    use_concise_error: see sandbox_rpc.parse_tool_response

  Returns:
    An instance of the return_type constructed using the result
    of the tool. If response is not decodable as JSON, raises a
    JSONDecodeError. If the JSON is not decodable as the passed in type,
    then returns a named tuple that corresponds to the JSON.
  """
  if remove_none_parameters:
    parameters = {k: v for k, v in parameters.items() if v is not None}
  response = run_tool(
      name=name,
      operation_id=operation_id,
      parameters=json.dumps(
          parameters, cls=DataclassJSONEncoder, sort_keys=True
      ),
  )
  with tool_operation_error.wrap_exception(name, operation_id, parameters):
    return parse_tool_response(
        tool_name=name,
        response=response,
        return_type=return_type,
        scope=scope,
        strict=strict,
        ignore_unrecognized_fields=ignore_unrecognized_fields,
        model_invisible_fields=model_invisible_fields,
        use_concise_error=use_concise_error,
    )
