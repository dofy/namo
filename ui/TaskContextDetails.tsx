import { Heading, Text } from '@radix-ui/themes';
import { t as tr, getLocale } from './i18n';
import type { TaskDetail } from '../src/ui-contract';

interface ContextDetail extends TaskDetail {
  materials?:{state:string;truncated:boolean;nodes:{id:string;name?:string;type:string;state:string;author?:{id?:string;name?:string};error?:string}[];limitations:string[]}[];
  artifacts?:{id:string;path:string;state:string;size?:number;sha256?:string;error?:string}[];
  activity?:{phase:string;updatedAt:number}[];
  progressUpdates?:{version:number;state:string;phase:string;error?:string}[];
}
export function TaskContextDetails({task}:{task:ContextDetail}){
  const states:Record<string,string>={
    received:tr("taskContext.state.received"),
    accessed:tr("taskContext.state.accessed"),
    parsed:tr("taskContext.state.parsed"),
    failed:tr("taskContext.state.failed"),
    unsupported:tr("taskContext.state.unsupported"),
    sent:tr("taskContext.state.sent"),
    unknown:tr("taskContext.state.unknown"),
    pending:tr("taskContext.state.pending"),
    uploaded:tr("taskContext.state.uploaded")
  };
  return <>
    {!!task.materials?.length&&<section><Heading as="h2" size="4">{tr("taskContext.materials")}</Heading>
      {task.materials.map((material,index)=><div className="result" key={index}>
        <Text as="p" size="2">{states[material.state]??material.state}{material.truncated?tr("taskContext.limited"):''}</Text>
        {material.nodes.map(node=><Text as="p" size="2" key={node.id}>{node.name??node.type} · {states[node.state]??node.state}{node.author?.name?` · ${node.author.name}`:''}{node.error?` · ${node.error}`:''}</Text>)}
        <details><summary>{tr("taskContext.readLimitsProvenance")}</summary>{material.limitations.map((item,i)=><Text as="p" size="1" key={i}>{item}</Text>)}</details>
      </div>)}
    </section>}
    {!!task.artifacts?.length&&<section><Heading as="h2" size="4">{tr("taskContext.fileDelivery")}</Heading>{task.artifacts.map(file=><div className="result" key={file.id}>
      <Text as="p" size="2">{file.path} · {states[file.state]??file.state}</Text><Text as="p" size="1" color="gray">{file.size??0} bytes · SHA-256 {file.sha256??'—'}</Text>
      {file.error&&<Text as="p" size="2" color="red">{file.error}</Text>}
    </div>)}</section>}
    {!!task.activity?.length&&<details><summary>{tr("taskContext.executionActivityProgressUpdates")}</summary>
      {task.activity.map((item,index)=><Text as="p" size="2" key={index}>{item.phase} · {new Date(item.updatedAt).toLocaleString(getLocale())}</Text>)}
      {task.progressUpdates?.slice(0,5).map(item=><Text as="p" size="1" key={item.version}>v{item.version} · {item.phase} · {item.state} {item.error??''}</Text>)}
    </details>}
  </>;
}
